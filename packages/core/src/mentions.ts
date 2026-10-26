import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lintCommitMessage } from './commit-lint.ts'
import { type Config, watcherHarnessConfig } from './config.ts'
import type { PrComment, PrDriver } from './drivers/pr.ts'
import type { AgentOutcome, AgentProcess, AgentUsage, Tracker } from './drivers/types.ts'
import { agentFailure, errMsg } from './errors.ts'
import { type AgentEvent, canTransition } from './events.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { commitFooter, modelFooter } from './footer.ts'
import { withHeadReflogBypassCheck } from './git-bypass.ts'
import { configuredCheckCommands, runMandatoryWorkerChecks } from './mandatory-checks.ts'
import { cacheHome } from './paths.ts'
import { type PrBodyMeta, taskIdFromPrBody } from './pr-body.ts'
import { type PrInfo, prepareConflictWorktree, pushConflictFix } from './pr-check.ts'
import { withPrWriteLock } from './pr-write-lock.ts'
import {
  classifyMentionPrompt,
  classifyMentionSystemPrompt,
  commitMessage,
  explainMentionPrompt,
  explainMentionSystemPrompt,
  fixChecksPrompt,
  flagPrompt,
  flagSystemPrompt,
  MAX_EXPLAIN_ANSWER_CHARS,
  MENTION_KINDS,
  type MentionKind,
  respondToMentionPrompt,
  respondToMentionSystemPrompt,
} from './prompt.ts'
import { parseQuickTaskDecision, quickTaskCandidates, resolveQuickTask } from './quick-task.ts'
import type { Store } from './store/store.ts'
import { recordWatcherAgentRun, type WatcherAgentSession } from './watcher-agent.ts'
import { taskIdFromBranch } from './worktree.ts'

export type { MentionKind } from './prompt.ts'

/**
 * Parse of the classifier's comma-separated reply into kinds, deduplicated and
 * in handler order. Each item must equal a known kind exactly; anything else is
 * dropped. flag excludes every other kind, and ambiguous applies only when
 * nothing else matched.
 */
export function parseMentionKinds(reply: string): MentionKind[] {
  const items = new Set(reply.split(',').map((item) => item.trim().toLowerCase()))
  const kinds = MENTION_KINDS.map(({ kind }) => kind).filter(
    (kind) => kind !== 'ambiguous' && items.has(kind),
  )
  if (kinds.includes('flag')) return ['flag']
  return kinds.length === 0 ? ['ambiguous'] : kinds
}

/** Handled-mention ids per registry repo key: repo names are not unique across the registry. */
export function mentionsPath(repo: string): string {
  return join(cacheHome(), 'amagi', 'mentions', `${repo}.json`)
}

/**
 * Reads `legacyPath` (the file named after the repo directory) while `path`
 * does not exist yet, so mentions answered before the move to repo keys stay
 * handled. The legacy file is never removed: a same-named repo may still need it.
 */
export function readHandledMentions(path: string, legacyPath?: string): Set<string> {
  try {
    const from = legacyPath !== undefined && !existsSync(path) ? legacyPath : path
    return new Set(JSON.parse(readFileSync(from, 'utf8')) as string[])
  } catch {
    return new Set()
  }
}

export function saveHandledMentions(path: string, ids: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify([...ids]))
}

/**
 * True when an allowlisted, non-agent author mentions the agent handle.
 * Shared by the one-shot responder and the continuous watcher so both enforce
 * the same author policy.
 */
export function isAgentMention(
  comment: PrComment,
  handle: string,
  allowedAuthors: readonly string[] = [],
): boolean {
  if (comment.body === '' || comment.user === handle || !allowedAuthors.includes(comment.user))
    return false
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`@${escaped}\\b`, 'i')
  return re.test(comment.body)
}

export type ListPrMentionsOptions = {
  driver: PrDriver
  cwd: string
  pr: PrInfo
  handle: string
  allowedAuthors: readonly string[]
}

/** Comments on a PR that mention the agent handle, from humans (never the agent itself). */
export async function listPrMentions(opts: ListPrMentionsOptions): Promise<PrComment[]> {
  const comments = await opts.driver.listComments(opts.cwd, opts.pr.number)
  return comments.filter((c) => isAgentMention(c, opts.handle, opts.allowedAuthors))
}

/** Live progress of one mention response, for a status line while it works. */
export type MentionProgress = {
  /** Human label of the phase currently running. */
  phase: string
  /** Elapsed milliseconds in the current phase. */
  phaseMs: number
  /** Total elapsed milliseconds across the whole response. */
  totalMs: number
  /** Latest agent usage reported by the harness, if any. */
  usage: AgentUsage | null
  /** Last agent tool used, if any (e.g. the check command the fix is running). */
  tool: string | null
}

/** The classifier's choices plus its raw reply, for the watcher to record as an event. */
export type MentionClassified = {
  kinds: MentionKind[]
  reply: string
}

export type RespondToMentionOptions = {
  /** Registry key used to attribute live watcher harness seats. */
  repo?: string
  root: string
  repoName: string
  pr: PrInfo
  mention: PrComment
  config: Config
  driver: PrDriver
  /** Tracker used to post flag reasons and create add-a-task issues; optional so callers without one still reply on the PR. */
  tracker?: Tracker
  exec?: Exec | undefined
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness | undefined
  /** Store used by the watcher to record each LLM call as a session. */
  store?: Store
  /** Called with live progress while a response is produced, for a status line. */
  onProgress?: (progress: MentionProgress) => void
  /** Called once classification settles, with the chosen kinds and the raw reply. */
  onClassified?: (classified: MentionClassified) => void
  /**
   * Persisted handled-mention ids. Each finished kind of a multi-kind mention
   * is recorded here as `<mention id>#<kind>`, so a retry after a later
   * handler failed skips the ones that already posted or pushed.
   */
  handled?: Set<string>
  /** Persists `handled`; called after each finished kind of a multi-kind mention. */
  saveHandled?: () => void
  /** Called when an agent moves HEAD outside the expected commit operation. */
  onGitBypassed?: (entries: string[]) => void
}

/**
 * Tracks and emits live progress while a mention is being responded to.
 * Surface state here; the caller decides how to render it.
 */
class Progress {
  private usage: AgentUsage | null = null
  private tool: string | null = null
  private phaseStart = Date.now()
  private readonly totalStart = Date.now()

  constructor(
    private readonly onProgress?: (p: MentionProgress) => void,
    private readonly store?: Store,
  ) {}

  /** Switch to a new phase, restarting its elapsed clock and reporting immediately. */
  phase(label: string): void {
    this.phaseStart = Date.now()
    this.tool = null
    this.emit(label)
  }

  /** Waits for the agent while surfacing elapsed time, tool use, and usage. */
  async agent(
    proc: AgentProcess,
    label: string,
    session?: Omit<WatcherAgentSession, 'store'>,
  ): Promise<AgentOutcome> {
    const tick = setInterval(() => this.emit(label), 1000)
    const onEvent = (event: AgentEvent): void => {
      if (event.kind === 'usage') {
        this.usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedTokens: event.cachedTokens ?? 0,
          costUsd: event.costUsd ?? null,
        }
      } else if (event.kind === 'tool_use') {
        this.tool = event.name
      } else if (event.kind === 'status') {
        this.emit(event.message)
      }
      this.emit(label)
    }
    try {
      if (session !== undefined && this.store !== undefined) {
        return await recordWatcherAgentRun(proc, { ...session, store: this.store }, onEvent)
      }
      for await (const event of proc.events()) {
        onEvent(event)
      }
      return await proc.done
    } finally {
      clearInterval(tick)
    }
  }

  private emit(label: string): void {
    if (!this.onProgress) return
    const now = Date.now()
    this.onProgress({
      phase: label,
      phaseMs: now - this.phaseStart,
      totalMs: now - this.totalStart,
      usage: this.usage,
      tool: this.tool,
    })
  }
}

/** Task id (e.g. "am-544") embedded in an amagi-authored PR title like "[am-544] Short name". */
export function taskIdFromPrTitle(title: string): string | null {
  return title.match(/\bam-[a-z0-9.]+\b/i)?.[0] ?? null
}

/**
 * Resolves the tracker task id for a PR, most to least reliable: the task id
 * the body was written with at creation (works for any tracker, and survives
 * a human editing the title); the branch name matched against the tracker's
 * open ids (for PRs that predate it); the PR title, as a
 * last resort for beads ids that still appear in the title.
 */
export async function resolveTaskId(pr: PrInfo, tracker: Tracker): Promise<string | null> {
  const fromBody = taskIdFromPrBody(pr.body)
  if (fromBody !== null) return fromBody
  const knownIds = tracker.openIds ? await tracker.openIds() : []
  const fromBranch = taskIdFromBranch(pr.headRefName, knownIds)
  if (fromBranch !== null) return fromBranch
  return taskIdFromPrTitle(pr.title)
}

function startImplementHarness(
  mk: typeof makeHarness,
  config: Config['harness']['implement'],
  cwd: string,
  prompt: string,
  systemPrompt: string,
  repo?: string,
  env?: Record<string, string>,
): AgentProcess {
  const harness = mk(config)
  return harness.start({
    cwd,
    prompt,
    systemPrompt,
    ...harnessStartOpts(config),
    ...(env === undefined ? {} : { env }),
    ...(repo === undefined ? {} : { seatActivity: { repo, watcher: 'mention-watcher' } }),
  })
}

/** Provenance footer for a canned reply, from the configured implement harness. */
function configuredFooter(config: Config): string {
  const { kind, model, effort } = watcherHarnessConfig(config, 'mention')
  return modelFooter(kind, model ?? null, effort ?? null)
}

/** Worktree on the PR head with base merged in, shared with conflict resolution. */
async function prWorktree(opts: RespondToMentionOptions, run: Exec, mergeMessage?: string) {
  return prepareConflictWorktree({
    repoRoot: opts.root,
    remote: opts.config.forge.remote,
    forgeKind: opts.config.forge.kind,
    repoName: opts.repoName,
    worktreeRoot: opts.config.repo.worktreeRoot,
    baseBranch: opts.config.repo.baseBranch,
    pr: opts.pr,
    persona: opts.config.repo.persona,
    ...(mergeMessage === undefined ? {} : { mergeMessage, deferCommit: true }),
    exec: run,
  })
}

async function respondToFix(opts: RespondToMentionOptions, run: Exec, p: Progress): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const harnessConfig = watcherHarnessConfig(opts.config, 'mention')
  p.phase('preparing worktree')
  const taskId = opts.tracker === undefined ? null : await resolveTaskId(opts.pr, opts.tracker)
  const task = taskId === null ? null : ((await opts.tracker?.get(taskId)) ?? null)
  const configuredHarness = watcherHarnessConfig(opts.config, 'mention')
  const commitMeta: PrBodyMeta = {
    harness: configuredHarness.kind,
    model: configuredHarness.model ?? null,
    effort: configuredHarness.effort ?? null,
  }
  const mergeSummary = `Merge: ${opts.config.repo.baseBranch} -> ${opts.pr.headRefName}.`
  const mergeMessage =
    task === null
      ? `[pr-${opts.pr.number}] Merge PR base\n\n${mergeSummary}\n\n${commitFooter(commitMeta.harness, commitMeta.model, commitMeta.effort)}\n`
      : mentionCommitMessage(task, mergeSummary, commitMeta)
  const wt = await prWorktree(opts, run, mergeMessage)
  const outPath = join(tmpdir(), `amagi-fix-pr-${opts.pr.number}-${opts.mention.id}.md`)
  try {
    p.phase('fixing in worktree')
    const { outcome, proc, checks } = await withHeadReflogBypassCheck(
      wt.path,
      run,
      async () => {
        const ctx = {
          pr: opts.pr,
          mention: opts.mention,
          worktree: wt.path,
          branch: wt.branch,
          baseBranch: opts.config.repo.baseBranch,
          checks: configuredCheckCommands(opts.config.checks),
          outPath,
          conflicted: wt.conflicted,
        }
        let prompt = respondToMentionPrompt(ctx)
        let checks: import('./events.ts').CheckResult[] = []
        for (let round = 0; ; round++) {
          const proc = startImplementHarness(
            mk,
            harnessConfig,
            wt.path,
            prompt,
            respondToMentionSystemPrompt(ctx),
            opts.repo,
            { AMAGI_WORKTREE: wt.path, AMAGI_REPO_ROOT: opts.root },
          )
          const outcome = await p.agent(proc, 'fixing in worktree', {
            role: 'implement',
            harness: harnessConfig.kind,
            source: `PR #${opts.pr.number} mention fix-pr`,
            cwd: wt.path,
          })
          if (!outcome.ok) return { outcome, proc, checks }
          checks = await runMandatoryWorkerChecks(
            run,
            wt.path,
            opts.config.checks,
            wt.baseOid,
            true,
          )
          if (taskId !== null)
            opts.store?.append(taskId, {
              type: 'checks.finished',
              ok: checks.every((result) => result.exitCode === 0),
              results: checks,
            })
          if (
            checks.every((result) => result.exitCode === 0) ||
            round >= opts.config.loop.maxCheckRounds
          ) {
            return { outcome, proc, checks }
          }
          prompt = `${fixChecksPrompt(checks)}\n\n${respondToMentionPrompt(ctx)}`
        }
      },
      opts.onGitBypassed,
      true,
    )
    if (!checks.every((result) => result.exitCode === 0)) {
      const detail = checks
        .filter((result) => result.exitCode !== 0)
        .map((result) => `$ ${result.command}\nexit ${result.exitCode}\n${result.output.trim()}`)
        .join('\n')
      const taskRow = taskId === null ? null : (opts.store?.task(taskId) ?? null)
      if (
        taskId !== null &&
        taskRow !== null &&
        opts.store !== undefined &&
        canTransition(taskRow.state, 'needs_human')
      ) {
        opts.store.append(taskId, {
          type: 'task.state',
          from: taskRow.state,
          to: 'needs_human',
          reason: `PR #${opts.pr.number} mention fix failed mandatory checks:\n${detail}${outcome.ok ? '' : `\nRepair agent failed: ${agentFailure(outcome)}`}`,
        })
      }
      throw new Error(
        `mandatory checks still fail after repair attempts:\n${detail}${outcome.ok ? '' : `\nRepair agent failed: ${agentFailure(outcome)}`}`,
      )
    }
    if (!outcome.ok) {
      throw new Error(`agent failed: ${agentFailure(outcome)}`)
    }
    const summary = readFileSync(outPath, 'utf8').trim()
    if (summary === '') throw new Error('agent produced no fix summary')
    const changed = await commitWorktree(run, wt.path, opts.pr, task, summary, commitMeta)
    p.phase('pushing fix')
    await pushConflictFix({
      cwd: wt.path,
      branch: wt.branch,
      headRef: opts.pr.headRefName,
      remote: opts.config.forge.remote,
      forgeKind: opts.config.forge.kind,
      exec: run,
    })
    const { kind, model, effort } = watcherHarnessConfig(opts.config, 'mention')
    const footer = modelFooter(kind, proc.model ?? model ?? null, proc.effort ?? effort ?? null)
    const result = changed ? summary : `No change was made: ${summary}`
    p.phase('posting comment')
    await opts.driver.postComment(
      opts.root,
      opts.pr.number,
      `@${opts.mention.user} ${result}${footer}`,
    )
  } finally {
    rmSync(outPath, { force: true })
  }
}

/** Stages and commits the fix, mirroring runner.commit: nothing to commit is fine, a git failure throws. */
function mentionCommitMessage(
  task: { id: string; title: string },
  summary: string,
  meta: PrBodyMeta,
): string {
  const message = commitMessage(task, summary, meta)
  const errors = lintCommitMessage(message)
  if (errors.length > 0) throw new Error(`malformed commit message: ${errors.join('; ')}`)
  return message
}

async function commitWorktree(
  run: Exec,
  cwd: string,
  pr: PrInfo,
  task: { id: string; title: string } | null,
  summary: string,
  meta: PrBodyMeta,
): Promise<boolean> {
  const status = await run(['git', 'status', '--porcelain'], { cwd })
  if (status.stdout.trim() === '') return false
  await run(['git', 'add', '-A'], { cwd })
  const message =
    task === null
      ? `[pr-${pr.number}] Respond to review feedback\n\n${summary.trim()}\n\n${commitFooter(meta.harness, meta.model, meta.effort)}\n`
      : mentionCommitMessage(task, summary, meta)
  const commit = await run(['git', 'commit', '-q', '-F', '-'], {
    cwd,
    stdin: message,
  })
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
  }
  return true
}

async function respondToExplain(
  opts: RespondToMentionOptions,
  run: Exec,
  p: Progress,
): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const harnessConfig = watcherHarnessConfig(opts.config, 'mention')
  p.phase('preparing worktree')
  const wt = await prWorktree(opts, run)
  const diff = await opts.driver.getPrDiff(opts.root, opts.pr.number)
  const branchPoint = await run(
    ['git', 'merge-base', `${opts.config.forge.remote}/${opts.pr.headRefName}`, wt.baseOid],
    { cwd: wt.path },
  )
  if (branchPoint.exitCode !== 0) {
    throw new Error(
      `could not find PR branch point: ${(branchPoint.stderr || branchPoint.stdout).trim()}`,
    )
  }
  const baseLog = await run(
    ['git', 'log', '--format=%h %s', '--reverse', `${branchPoint.stdout.trim()}..${wt.baseOid}`],
    { cwd: wt.path },
  )
  if (baseLog.exitCode !== 0) {
    throw new Error(`could not read base commits: ${(baseLog.stderr || baseLog.stdout).trim()}`)
  }
  const baseCommits = baseLog.stdout.trim() === '' ? [] : baseLog.stdout.trim().split('\n')
  const outPath = join(tmpdir(), `amagi-explain-${opts.pr.number}-${opts.mention.id}.md`)
  try {
    p.phase('explaining')
    const { outcome, proc } = await withHeadReflogBypassCheck(
      wt.path,
      run,
      async () => {
        const proc = startImplementHarness(
          mk,
          harnessConfig,
          wt.path,
          explainMentionPrompt({
            pr: opts.pr,
            mention: opts.mention,
            diff,
            baseCommits,
            outPath,
            conflicted: wt.conflicted,
          }),
          explainMentionSystemPrompt(),
          opts.repo,
          { AMAGI_WORKTREE: wt.path, AMAGI_REPO_ROOT: opts.root },
        )
        return {
          outcome: await p.agent(proc, 'explaining', {
            role: 'triage',
            harness: harnessConfig.kind,
            source: `PR #${opts.pr.number} mention explain`,
            cwd: wt.path,
          }),
          proc,
        }
      },
      opts.onGitBypassed,
    )
    if (!outcome.ok) {
      throw new Error(`agent failed: ${agentFailure(outcome)}`)
    }
    const explanation = readFileSync(outPath, 'utf8').trim()
    if (explanation === '') throw new Error('agent produced no explanation')
    p.phase('posting comment')
    const { kind, model, effort } = watcherHarnessConfig(opts.config, 'mention')
    const footer = modelFooter(kind, proc.model ?? model ?? null, proc.effort ?? effort ?? null)
    await opts.driver.postComment(
      opts.root,
      opts.pr.number,
      `${limitExplanation(explanation)}${footer}`,
    )
  } finally {
    rmSync(outPath, { force: true })
  }
}

function limitExplanation(answer: string): string {
  const chars = Array.from(answer)
  if (chars.length <= MAX_EXPLAIN_ANSWER_CHARS) return answer
  const prefix = chars.slice(0, MAX_EXPLAIN_ANSWER_CHARS - 1).join('')
  const lastSpace = prefix.lastIndexOf(' ')
  const end = lastSpace > MAX_EXPLAIN_ANSWER_CHARS / 2 ? lastSpace : prefix.length
  return `${prefix.slice(0, end).trimEnd()}…`
}

async function askClarification(opts: RespondToMentionOptions, p: Progress): Promise<void> {
  p.phase('asking clarification')
  const question = [
    `@${opts.mention.user} I'm not sure what you'd like me to do with your comment.`,
    'Do you want me to change the code (fix something), are you asking me to explain the changes, or should I log it as a new task? Please clarify.',
  ].join('\n\n')
  await opts.driver.postComment(
    opts.root,
    opts.pr.number,
    `${question}${configuredFooter(opts.config)}`,
  )
}

/** Lets the LLM decide the response path, rather than assuming a fixed one. */
async function classifyMention(opts: RespondToMentionOptions, p: Progress): Promise<MentionKind[]> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const harnessConfig = watcherHarnessConfig(opts.config, 'mention')
  p.phase('classifying')
  // Context only sharpens routing; a forge hiccup must not block every mention on the PR.
  const changes = await opts.driver.getPrChanges(opts.root, opts.pr.number).catch((err) => {
    console.warn(`mention classification #${opts.pr.number}: no PR changes: ${errMsg(err)}`)
    return { baseSha: null, headSha: opts.pr.headRefOid, changedFiles: [], fileCount: 0 }
  })
  // A throwaway cwd and no tools: classification routes on forge metadata alone.
  const proc = mk(harnessConfig).start({
    cwd: tmpdir(),
    prompt: classifyMentionPrompt({ pr: opts.pr, changes, mention: opts.mention }),
    systemPrompt: classifyMentionSystemPrompt(),
    model: harnessConfig.model,
    effort: harnessConfig.effort,
    ...(harnessConfig.seat === undefined ? {} : { seat: harnessConfig.seat }),
    permissions: 'read-only',
    allowedTools: [],
    ...(opts.repo === undefined
      ? {}
      : { seatActivity: { repo: opts.repo, watcher: 'mention-watcher' } }),
  })
  const outcome = await p.agent(proc, 'classifying', {
    role: 'triage',
    harness: harnessConfig.kind,
    source: `PR #${opts.pr.number} mention classification`,
    cwd: tmpdir(),
  })
  if (!outcome.ok) {
    throw new Error(`classifier failed: ${agentFailure(outcome)}`)
  }
  const reply = outcome.summary ?? ''
  const kinds = parseMentionKinds(reply)
  opts.onClassified?.({ kinds, reply })
  return kinds
}

function quickTaskPrompt(
  opts: RespondToMentionOptions,
  candidates: Awaited<ReturnType<typeof quickTaskCandidates>>,
): string {
  return [
    'Draft one issue for this PR mention. The service will create it through the configured tracker.',
    'Do not run commands or access the tracker directly. Existing open and in-progress issues are supplied below.',
    'Record ordinary missing details as assumptions. Ask a focused question only when materially different interpretations would make a task useless or harmful.',
    'If a supplied issue already covers the request, return its ID. If the supplied context proves it is already fixed, return the evidence.',
    'Reply with exactly one JSON object in one of these shapes:',
    '{"status":"create","title":"short imperative title","context":"why","goal":"outcome","scope":"boundaries","assumptions":"filled-in details","acceptance":"observable completion criteria"}',
    '{"status":"existing","id":"ID from supplied issues"}',
    '{"status":"fixed","explanation":"brief reason"}',
    '{"status":"clarification","question":"one focused question"}',
    '',
    `PR #${opts.pr.number}: ${opts.pr.title} (${opts.pr.url})`,
    `Mention by @${opts.mention.user}:`,
    opts.mention.body.trim(),
    '',
    'Existing issues:',
    JSON.stringify(
      candidates.map(({ id, title, description, status }) => ({ id, title, description, status })),
    ),
  ].join('\n')
}

async function respondToAddTask(opts: RespondToMentionOptions, p: Progress): Promise<void> {
  p.phase('creating a task')
  const tracker = opts.tracker
  if (tracker === undefined || !tracker.capabilities.create) {
    await opts.driver.postComment(
      opts.root,
      opts.pr.number,
      `@${opts.mention.user} I'd log this as a task, but the configured tracker (${tracker?.kind ?? 'none'}) can't create issues.${configuredFooter(opts.config)}`,
    )
    return
  }
  const mk = opts.makeHarnessFn ?? makeHarness
  const harnessConfig = watcherHarnessConfig(opts.config, 'mention')
  const candidates = await quickTaskCandidates(tracker)
  const proc = mk(harnessConfig).start({
    cwd: tmpdir(),
    prompt: quickTaskPrompt(opts, candidates),
    systemPrompt: 'Return only the requested JSON. Do not use tools or run commands.',
    model: harnessConfig.model,
    effort: harnessConfig.effort,
    ...(harnessConfig.seat === undefined ? {} : { seat: harnessConfig.seat }),
    permissions: 'read-only',
    allowedTools: [],
    ...(opts.repo === undefined
      ? {}
      : { seatActivity: { repo: opts.repo, watcher: 'mention-watcher' } }),
  })
  const outcome = await p.agent(proc, 'drafting a task', {
    role: 'triage',
    harness: harnessConfig.kind,
    source: `PR #${opts.pr.number} quick-task draft`,
    cwd: tmpdir(),
  })
  if (!outcome.ok) throw new Error(`task drafter failed: ${agentFailure(outcome)}`)
  const result = await resolveQuickTask(
    tracker,
    candidates,
    parseQuickTaskDecision(outcome.summary ?? ''),
  )
  const response =
    result.status === 'issue'
      ? `@${opts.mention.user} Logged this as ${result.issue}.`
      : result.status === 'fixed'
        ? `@${opts.mention.user} This appears to be already fixed: ${result.explanation}`
        : `@${opts.mention.user} ${result.question}`
  await opts.driver.postComment(
    opts.root,
    opts.pr.number,
    `${response}${configuredFooter(opts.config)}`,
  )
}

/**
 * Lets the LLM judge whether a PR should be flagged for closure. When it rules
 * `TAKE DOWN`, the reason is posted as a comment on the task issue in the
 * tracker; a `KEEP` verdict only replies on the PR. The agent never touches
 * the forge itself, so nothing is closed or reverted automatically.
 */
async function respondToFlag(opts: RespondToMentionOptions, run: Exec, p: Progress): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const harnessConfig = watcherHarnessConfig(opts.config, 'mention')
  p.phase('preparing worktree')
  const wt = await prWorktree(opts, run)
  const outPath = join(tmpdir(), `amagi-flag-${opts.pr.number}-${opts.mention.id}.md`)
  let verdict: string
  let reason: string
  try {
    p.phase('judging')
    const outcome = await withHeadReflogBypassCheck(
      wt.path,
      run,
      () => {
        const proc = startImplementHarness(
          mk,
          harnessConfig,
          wt.path,
          flagPrompt({
            pr: opts.pr,
            mention: opts.mention,
            outPath,
            conflicted: wt.conflicted,
          }),
          flagSystemPrompt(),
          opts.repo,
          { AMAGI_WORKTREE: wt.path, AMAGI_REPO_ROOT: opts.root },
        )
        return p.agent(proc, 'judging', {
          role: 'triage',
          harness: harnessConfig.kind,
          source: `PR #${opts.pr.number} mention flag`,
          cwd: wt.path,
        })
      },
      opts.onGitBypassed,
    )
    if (!outcome.ok) {
      throw new Error(
        `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
      )
    }
    const raw = readFileSync(outPath, 'utf8').trim()
    if (raw === '') throw new Error('agent produced no flag verdict')
    verdict = raw.split('\n', 1)[0]?.trim().toUpperCase() ?? ''
    reason = raw.split('\n').slice(1).join('\n').trim()
    if (reason === '') reason = raw
  } finally {
    rmSync(outPath, { force: true })
  }

  p.phase('posting comment')
  await opts.driver.postComment(opts.root, opts.pr.number, reason)
  if (verdict !== 'TAKE DOWN') return
  if (opts.tracker === undefined) return

  const taskId = await resolveTaskId(opts.pr, opts.tracker)
  if (taskId === null) return
  const task = await opts.tracker.get(taskId)
  if (task === null) return
  await opts.tracker.comment(taskId, reason)
}

async function runMentionKind(
  kind: MentionKind,
  opts: RespondToMentionOptions,
  run: Exec,
  p: Progress,
): Promise<void> {
  const locked = (fn: () => Promise<void>) =>
    withPrWriteLock(opts.root, opts.config.forge.remote, opts.pr.headRefName, fn)
  switch (kind) {
    case 'fix-pr':
      return locked(() => respondToFix(opts, run, p))
    case 'explain':
      return locked(() => respondToExplain(opts, run, p))
    case 'flag':
      return locked(() => respondToFlag(opts, run, p))
    case 'add-a-task':
      return respondToAddTask(opts, p)
    case 'ambiguous':
      return askClarification(opts, p)
  }
}

/**
 * Responds to a single mention, running a handler for every kind it was
 * classified as, in MENTION_KINDS order. Throws on the first failed handler
 * so the caller can retry. A multi-kind retry reuses the kinds recorded on
 * the first attempt instead of reclassifying, and skips the finished ones.
 */
export async function respondToMention(opts: RespondToMentionOptions): Promise<MentionKind[]> {
  const run = opts.exec ?? defaultExec
  const p = new Progress(opts.onProgress, opts.store)
  const kindsKey = `${opts.mention.id}#kinds=`
  const recorded = [...(opts.handled ?? [])].find((id) => id.startsWith(kindsKey))
  const kinds =
    recorded === undefined
      ? await classifyMention(opts, p)
      : parseMentionKinds(recorded.slice(kindsKey.length))
  const record = (entry: string): void => {
    if (kinds.length < 2 || opts.handled === undefined) return
    opts.handled.add(entry)
    opts.saveHandled?.()
  }
  if (recorded === undefined) record(`${kindsKey}${kinds.join(',')}`)
  for (const kind of kinds) {
    const done = `${opts.mention.id}#${kind}`
    if (opts.handled?.has(done)) continue
    await runMentionKind(kind, opts, run, p)
    record(done)
  }
  return kinds
}
