import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lintCommitMessage } from './commit-lint.ts'
import { type Config, watcherHarnessConfig } from './config.ts'
import { classifyDifficulty } from './difficulty.ts'
import type { PrComment, PrDriver } from './drivers/pr.ts'
import type { AgentOutcome, AgentProcess, AgentUsage, Tracker } from './drivers/types.ts'
import { agentFailure } from './errors.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { modelFooter } from './footer.ts'
import { withHeadReflogBypassCheck } from './git-bypass.ts'
import { cacheHome } from './paths.ts'
import { type PrBodyMeta, taskIdFromPrBody } from './pr-body.ts'
import { type PrInfo, prepareConflictWorktree, pushConflictFix } from './pr-check.ts'
import {
  classifyMentionPrompt,
  classifyMentionSystemPrompt,
  commitMessage,
  explainMentionPrompt,
  explainMentionSystemPrompt,
  respondToMentionPrompt,
  respondToMentionSystemPrompt,
  takeDownPrompt,
  takeDownSystemPrompt,
} from './prompt.ts'
import { taskIdFromBranch } from './worktree.ts'

export type MentionKind = 'fix-pr' | 'explain' | 'add-a-task' | 'take-down' | 'ambiguous'

const MENTION_KINDS: readonly MentionKind[] = [
  'fix-pr',
  'explain',
  'add-a-task',
  'take-down',
  'ambiguous',
]

/** Parse of the classifier's reply; only an exact known kind matches, anything else is ambiguous. */
export function parseMentionKind(reply: string): MentionKind {
  const kind = reply.trim().toLowerCase()
  return MENTION_KINDS.includes(kind as MentionKind) ? (kind as MentionKind) : 'ambiguous'
}

export function mentionsPath(repoName: string): string {
  return join(cacheHome(), 'amagi', 'mentions', `${repoName}.json`)
}

export function readHandledMentions(path: string): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(path, 'utf8')) as string[])
  } catch {
    return new Set()
  }
}

export function saveHandledMentions(path: string, ids: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify([...ids]))
}

/**
 * True when a comment mentions the agent handle and was written by a human.
 * Shared by the one-shot responder and the continuous watcher so both agree on
 * what counts as a mention.
 */
export function isAgentMention(comment: PrComment, handle: string): boolean {
  if (comment.body === '' || comment.user === handle) return false
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`@${escaped}\\b`, 'i')
  return re.test(comment.body)
}

export type ListPrMentionsOptions = {
  driver: PrDriver
  cwd: string
  pr: PrInfo
  handle: string
}

/** Comments on a PR that mention the agent handle, from humans (never the agent itself). */
export async function listPrMentions(opts: ListPrMentionsOptions): Promise<PrComment[]> {
  const comments = await opts.driver.listComments(opts.cwd, opts.pr.number)
  return comments.filter((c) => isAgentMention(c, opts.handle))
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

/** The classifier's choice plus its raw reply, for the watcher to record as an event. */
export type MentionClassified = {
  kind: MentionKind
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
  /** Tracker used to post take-down reasons and log add-a-task responses; optional so callers without one still reply on the PR. */
  tracker?: Tracker
  exec?: Exec | undefined
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness | undefined
  /** Called with live progress while a response is produced, for a status line. */
  onProgress?: (progress: MentionProgress) => void
  /** Called once classification settles, with the chosen kind and the raw reply. */
  onClassified?: (classified: MentionClassified) => void
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

  constructor(private readonly onProgress?: (p: MentionProgress) => void) {}

  /** Switch to a new phase, restarting its elapsed clock and reporting immediately. */
  phase(label: string): void {
    this.phaseStart = Date.now()
    this.tool = null
    this.emit(label)
  }

  /** Waits for the agent while surfacing elapsed time, tool use, and usage. */
  async agent(proc: AgentProcess, label: string): Promise<AgentOutcome> {
    const tick = setInterval(() => this.emit(label), 1000)
    try {
      for await (const event of proc.events()) {
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

/** Task id (e.g. "am-544") embedded in an amagi-authored PR title like "am-544: Short name". */
export function taskIdFromPrTitle(title: string): string | null {
  return title.match(/\bam-[a-z0-9.]+\b/i)?.[0] ?? null
}

/**
 * Resolves the tracker task id for a PR, most to least reliable: the task id
 * the body was written with at creation (works for any tracker, and survives
 * a human editing the title); the branch name matched against the tracker's
 * open ids (for PRs that predate it); the PR title, as a
 * last resort for beads ids that happen to still carry the "am-544: " prefix.
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
    repoName: opts.repoName,
    worktreeRoot: opts.config.repo.worktreeRoot,
    baseBranch: opts.config.repo.baseBranch,
    pr: opts.pr,
    persona: opts.config.repo.persona,
    ...(mergeMessage === undefined ? {} : { mergeMessage }),
    exec: run,
  })
}

async function respondToFix(opts: RespondToMentionOptions, run: Exec, p: Progress): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  p.phase('preparing worktree')
  const taskId = opts.tracker === undefined ? null : await resolveTaskId(opts.pr, opts.tracker)
  const task = taskId === null ? null : ((await opts.tracker?.get(taskId)) ?? null)
  const configuredHarness = watcherHarnessConfig(opts.config, 'mention')
  const commitMeta: PrBodyMeta = {
    harness: configuredHarness.kind,
    model: configuredHarness.model ?? null,
    effort: configuredHarness.effort ?? null,
  }
  const mergeMessage =
    task === null
      ? undefined
      : mentionCommitMessage(
          task,
          `Merged base branch '${opts.config.repo.baseBranch}' into PR #${opts.pr.number} head.`,
          commitMeta,
        )
  const wt = await prWorktree(opts, run, mergeMessage)
  const outPath = join(tmpdir(), `amagi-fix-pr-${opts.pr.number}-${opts.mention.id}.md`)
  try {
    p.phase('fixing in worktree')
    const { outcome, proc } = await withHeadReflogBypassCheck(
      wt.path,
      run,
      async () => {
        const ctx = {
          pr: opts.pr,
          mention: opts.mention,
          worktree: wt.path,
          branch: wt.branch,
          baseBranch: opts.config.repo.baseBranch,
          checks: opts.config.checks.commands,
          outPath,
          conflicted: wt.conflicted,
        }
        const proc = startImplementHarness(
          mk,
          watcherHarnessConfig(opts.config, 'mention'),
          wt.path,
          respondToMentionPrompt(ctx),
          respondToMentionSystemPrompt(ctx),
          opts.repo,
          { AMAGI_WORKTREE: wt.path, AMAGI_REPO_ROOT: opts.root },
        )
        return { outcome: await p.agent(proc, 'fixing in worktree'), proc }
      },
      opts.onGitBypassed,
    )
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
      ? `Respond to review feedback on PR #${pr.number}\n\nPR: ${pr.url}`
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
  p.phase('preparing worktree')
  const wt = await prWorktree(opts, run)
  const diff = await opts.driver.getPrDiff(opts.root, opts.pr.number)
  const outPath = join(tmpdir(), `amagi-explain-${opts.pr.number}-${opts.mention.id}.md`)
  try {
    p.phase('explaining')
    const { outcome, proc } = await withHeadReflogBypassCheck(
      wt.path,
      run,
      async () => {
        const proc = startImplementHarness(
          mk,
          watcherHarnessConfig(opts.config, 'mention'),
          wt.path,
          explainMentionPrompt({
            pr: opts.pr,
            mention: opts.mention,
            diff,
            outPath,
            conflicted: wt.conflicted,
          }),
          explainMentionSystemPrompt(),
          opts.repo,
        )
        return { outcome: await p.agent(proc, 'explaining'), proc }
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
    await opts.driver.postComment(opts.root, opts.pr.number, `${explanation}${footer}`)
  } finally {
    rmSync(outPath, { force: true })
  }
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
async function classifyMention(opts: RespondToMentionOptions, p: Progress): Promise<MentionKind> {
  const mk = opts.makeHarnessFn ?? makeHarness
  // A throwaway cwd: classification needs no repo context and must not touch one.
  p.phase('classifying')
  const proc = startImplementHarness(
    mk,
    watcherHarnessConfig(opts.config, 'mention'),
    tmpdir(),
    classifyMentionPrompt({ pr: opts.pr, mention: opts.mention }),
    classifyMentionSystemPrompt(),
    opts.repo,
  )
  const outcome = await p.agent(proc, 'classifying')
  if (!outcome.ok) {
    throw new Error(`classifier failed: ${agentFailure(outcome)}`)
  }
  const reply = outcome.summary ?? ''
  const kind = parseMentionKind(reply)
  opts.onClassified?.({ kind, reply })
  return kind
}

function addTaskTitle(opts: RespondToMentionOptions): string {
  const firstLine = opts.mention.body.trim().split('\n')[0] ?? 'New task'
  return `PR #${opts.pr.number}: ${firstLine.slice(0, 80)}`
}

async function respondToAddTask(opts: RespondToMentionOptions, p: Progress): Promise<void> {
  p.phase('logging a task')
  const tracker = opts.tracker
  if (tracker === undefined || !tracker.capabilities.create) {
    await opts.driver.postComment(
      opts.root,
      opts.pr.number,
      `@${opts.mention.user} I'd log this as a task, but the configured tracker (${tracker?.kind ?? 'none'}) can't create issues.${configuredFooter(opts.config)}`,
    )
    return
  }
  const description = [
    `From @${opts.mention.user} on PR #${opts.pr.number} "${opts.pr.title}" (${opts.pr.url}):`,
    '',
    opts.mention.body.trim(),
  ].join('\n')
  const title = addTaskTitle(opts)
  const difficulty = opts.config.difficulty.enabled
    ? await classifyDifficulty(title, description, opts.config)
    : null
  const task = await tracker.createTask({
    title,
    description,
    acceptanceCriteria: null,
    priority: null,
    labels: [],
    dependencies: [],
    parent: null,
    ...(difficulty === null ? {} : { difficulty }),
  })
  const where = task.url ?? `task ${task.id}`
  await opts.driver.postComment(
    opts.root,
    opts.pr.number,
    `@${opts.mention.user} Logged this as ${where}.${configuredFooter(opts.config)}`,
  )
}

/**
 * Lets the LLM judge whether a PR deserves to be taken down. When it rules
 * `TAKE DOWN`, the reason is posted as a comment on the task issue in the
 * tracker; a `KEEP` verdict only replies on the PR. The agent never touches
 * the forge itself, so nothing is closed or reverted automatically.
 */
async function respondToTakeDown(
  opts: RespondToMentionOptions,
  run: Exec,
  p: Progress,
): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  p.phase('preparing worktree')
  const wt = await prWorktree(opts, run)
  const outPath = join(tmpdir(), `amagi-takedown-${opts.pr.number}-${opts.mention.id}.md`)
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
          watcherHarnessConfig(opts.config, 'mention'),
          wt.path,
          takeDownPrompt({
            pr: opts.pr,
            mention: opts.mention,
            outPath,
            conflicted: wt.conflicted,
          }),
          takeDownSystemPrompt(),
          opts.repo,
        )
        return p.agent(proc, 'judging')
      },
      opts.onGitBypassed,
    )
    if (!outcome.ok) {
      throw new Error(
        `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
      )
    }
    const raw = readFileSync(outPath, 'utf8').trim()
    if (raw === '') throw new Error('agent produced no take-down verdict')
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

/** Responds to a single mention. Throws when the response fails so the caller can retry. */
export async function respondToMention(opts: RespondToMentionOptions): Promise<MentionKind> {
  const run = opts.exec ?? defaultExec
  const p = new Progress(opts.onProgress)
  const kind = await classifyMention(opts, p)
  switch (kind) {
    case 'fix-pr':
      await respondToFix(opts, run, p)
      return 'fix-pr'
    case 'explain':
      await respondToExplain(opts, run, p)
      return 'explain'
    case 'take-down':
      await respondToTakeDown(opts, run, p)
      return 'take-down'
    case 'add-a-task':
      await respondToAddTask(opts, p)
      return 'add-a-task'
    case 'ambiguous':
      await askClarification(opts, p)
      return 'ambiguous'
  }
}
