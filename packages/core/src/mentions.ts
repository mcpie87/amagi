import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import { classifyDifficulty } from './difficulty.ts'
import type { PrComment, PrDriver } from './drivers/pr.ts'
import type { AgentOutcome, AgentProcess, AgentUsage, Tracker } from './drivers/types.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { modelFooter } from './footer.ts'
import { cacheHome } from './paths.ts'
import { type PrInfo, prepareConflictWorktree, pushConflictFix } from './pr-check.ts'
import {
  classifyMentionPrompt,
  classifyMentionSystemPrompt,
  explainMentionPrompt,
  explainMentionSystemPrompt,
  respondToMentionPrompt,
  respondToMentionSystemPrompt,
} from './prompt.ts'

export type MentionKind = 'fix-pr' | 'explain' | 'add-a-task' | 'ambiguous'

const MENTION_KINDS: readonly MentionKind[] = ['fix-pr', 'explain', 'add-a-task', 'ambiguous']

/** Best-effort parse of the classifier's reply; anything unrecognised is ambiguous. */
export function parseMentionKind(reply: string): MentionKind {
  const lower = reply.toLowerCase()
  for (const k of MENTION_KINDS) {
    if (lower.includes(k)) return k
  }
  return 'ambiguous'
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

/** Last-seen comment per open PR, so the watcher skips PRs that have not changed. */
export type MentionWatchState = Record<string, { updatedAt: string; lastCommentId: number }>

export function mentionWatchPath(repoName: string): string {
  return join(cacheHome(), 'amagi', 'mentions', `${repoName}.watch.json`)
}

export function readMentionWatch(path: string): MentionWatchState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MentionWatchState
  } catch {
    return {}
  }
}

export function saveMentionWatch(path: string, state: MentionWatchState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
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

export type RespondToMentionOptions = {
  root: string
  repoName: string
  pr: PrInfo
  mention: PrComment
  config: Config
  driver: PrDriver
  /** Tracker used by the add-a-task response; optional so callers without one still work. */
  tracker?: Tracker
  exec?: Exec
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness
  /** Called with live progress while a response is produced, for a status line. */
  onProgress?: (progress: MentionProgress) => void
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

function startImplementHarness(
  mk: typeof makeHarness,
  config: Config['harness']['implement'],
  cwd: string,
  prompt: string,
  systemPrompt: string,
): AgentProcess {
  const harness = mk(config)
  return harness.start({
    cwd,
    prompt,
    systemPrompt,
    ...harnessStartOpts(config),
  })
}

/** Provenance footer for a canned reply, from the configured implement harness. */
function configuredFooter(config: Config): string {
  const { kind, model, effort } = config.harness.implement
  return modelFooter(kind, model ?? null, effort ?? null)
}

/** Worktree on the PR head with base merged in, shared with conflict resolution. */
async function prWorktree(opts: RespondToMentionOptions, run: Exec) {
  return prepareConflictWorktree({
    repoRoot: opts.root,
    repoName: opts.repoName,
    worktreeRoot: opts.config.repo.worktreeRoot,
    baseBranch: opts.config.repo.baseBranch,
    pr: opts.pr,
    persona: opts.config.repo.persona,
    exec: run,
  })
}

async function respondToFix(opts: RespondToMentionOptions, run: Exec, p: Progress): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  p.phase('preparing worktree')
  const wt = await prWorktree(opts, run)
  p.phase('fixing in worktree')
  const proc = startImplementHarness(
    mk,
    opts.config.harness.implement,
    wt.path,
    respondToMentionPrompt({
      pr: opts.pr,
      mention: opts.mention,
      worktree: wt.path,
      branch: wt.branch,
      baseBranch: opts.config.repo.baseBranch,
      checks: opts.config.checks.commands,
    }),
    respondToMentionSystemPrompt({
      pr: opts.pr,
      mention: opts.mention,
      worktree: wt.path,
      branch: wt.branch,
      baseBranch: opts.config.repo.baseBranch,
      checks: opts.config.checks.commands,
    }),
  )
  const outcome = await p.agent(proc, 'fixing in worktree')
  if (!outcome.ok) {
    throw new Error(
      `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
    )
  }
  p.phase('pushing fix')
  await pushConflictFix({
    cwd: wt.path,
    branch: wt.branch,
    headRef: opts.pr.headRefName,
    remote: opts.config.forge.remote,
    exec: run,
  })
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
    const proc = startImplementHarness(
      mk,
      opts.config.harness.implement,
      wt.path,
      explainMentionPrompt({
        pr: opts.pr,
        mention: opts.mention,
        diff,
        outPath,
      }),
      explainMentionSystemPrompt(),
    )
    const outcome = await p.agent(proc, 'explaining')
    if (!outcome.ok) {
      throw new Error(
        `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
      )
    }
    const explanation = readFileSync(outPath, 'utf8').trim()
    if (explanation === '') throw new Error('agent produced no explanation')
    p.phase('posting comment')
    const { kind, model, effort } = opts.config.harness.implement
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
    opts.config.harness.implement,
    tmpdir(),
    classifyMentionPrompt({ pr: opts.pr, mention: opts.mention }),
    classifyMentionSystemPrompt(),
  )
  const outcome = await p.agent(proc, 'classifying')
  if (!outcome.ok) {
    throw new Error(
      `classifier failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
    )
  }
  return parseMentionKind(outcome.summary ?? '')
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
    ...(difficulty === null ? {} : { difficulty }),
  })
  const where = task.url ?? `task ${task.id}`
  await opts.driver.postComment(
    opts.root,
    opts.pr.number,
    `@${opts.mention.user} Logged this as ${where}.${configuredFooter(opts.config)}`,
  )
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
    case 'add-a-task':
      await respondToAddTask(opts, p)
      return 'add-a-task'
    case 'ambiguous':
      await askClarification(opts, p)
      return 'ambiguous'
  }
}
