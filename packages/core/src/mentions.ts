import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import type { PrComment, PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Tracker } from './drivers/types.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { makeHarness } from './factory.ts'
import { cacheHome } from './paths.ts'
import { type PrInfo, prepareConflictWorktree, pushConflictFix } from './pr-check.ts'
import {
  explainMentionPrompt,
  explainMentionSystemPrompt,
  respondToMentionPrompt,
  respondToMentionSystemPrompt,
  takeDownPrompt,
  takeDownSystemPrompt,
} from './prompt.ts'

export type MentionKind = 'fix' | 'explain' | 'take-down' | 'ambiguous'

/** A human asking to take the PR down (close, withdraw, or revert it). */
const TAKE_DOWN_RE =
  /\btaken?\s+down\b|\b(take|pull)\s+(?:this|the|that)\s+(?:pr|pull request|change)\s+down\b|\b(withdraw|retract)\s+(?:this|the|that)\s+(?:pr|pull request|change)?\b|\bclose\s+(?:this|the)\s+(?:pr|pull request)\b|\brevert\s+(?:this|the)\s+(?:pr|pull request)\b/i
/** A human asking to change the code. */
const FIX_RE =
  /\b(fix|remove|delete|revert|change|redo|rewrite|wrong|incorrect|broken|bug|should not|shouldn't|unnecessary|address|resolve)\b/i
/** A human asking for an explanation. Takes precedence: "why did you add X" is not a fix. */
const EXPLAIN_RE = /\b(why|explain|justify|rationale|reason for|how come)\b/i

export function classifyMention(body: string): MentionKind {
  if (EXPLAIN_RE.test(body)) return 'explain'
  if (TAKE_DOWN_RE.test(body)) return 'take-down'
  if (FIX_RE.test(body)) return 'fix'
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

export type ListPrMentionsOptions = {
  driver: PrDriver
  cwd: string
  pr: PrInfo
  handle: string
}

/** Comments on a PR that mention the agent handle, from humans (never the agent itself). */
export async function listPrMentions(opts: ListPrMentionsOptions): Promise<PrComment[]> {
  const comments = await opts.driver.listComments(opts.cwd, opts.pr.number)
  const escaped = opts.handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`@${escaped}\\b`, 'i')
  return comments.filter((c) => c.body !== '' && c.user !== opts.handle && re.test(c.body))
}

export type RespondToMentionOptions = {
  root: string
  repoName: string
  pr: PrInfo
  mention: PrComment
  config: Config
  driver: PrDriver
  /** Tracker used to post the take-down reason on the task issue; optional so callers without one still reply on the PR. */
  tracker?: Tracker
  exec?: Exec
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness
}

/** Task id (e.g. "am-544") embedded in an amagi-authored PR title like "am-544: Short name". */
export function taskIdFromPrTitle(title: string): string | null {
  return title.match(/\bam-[a-z0-9.]+\b/i)?.[0] ?? null
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
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.effort === undefined ? {} : { effort: config.effort }),
    permissions: config.permissions,
    extraArgs: config.extraArgs,
  })
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

async function respondToFix(opts: RespondToMentionOptions, run: Exec): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const wt = await prWorktree(opts, run)
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
  const outcome = await proc.done
  if (!outcome.ok) {
    throw new Error(
      `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
    )
  }
  await pushConflictFix({
    cwd: wt.path,
    branch: wt.branch,
    headRef: opts.pr.headRefName,
    remote: opts.config.forge.remote,
    exec: run,
  })
}

async function respondToExplain(opts: RespondToMentionOptions, run: Exec): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const wt = await prWorktree(opts, run)
  const diff = await execOk(run, ['gh', 'pr', 'diff', String(opts.pr.number)], { cwd: opts.root })
  const outPath = join(tmpdir(), `amagi-explain-${opts.pr.number}-${opts.mention.id}.md`)
  try {
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
    const outcome = await proc.done
    if (!outcome.ok) {
      throw new Error(
        `agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
      )
    }
    const explanation = readFileSync(outPath, 'utf8').trim()
    if (explanation === '') throw new Error('agent produced no explanation')
    await opts.driver.postComment(opts.root, opts.pr.number, explanation)
  } finally {
    rmSync(outPath, { force: true })
  }
}

async function askClarification(opts: RespondToMentionOptions): Promise<void> {
  const question = [
    `@${opts.mention.user} I'm not sure what you'd like me to do with your comment.`,
    'Do you want me to change the code (fix something), or are you asking me to explain the changes? Please clarify.',
  ].join('\n\n')
  await opts.driver.postComment(opts.root, opts.pr.number, question)
}

/**
 * Lets the LLM judge whether a PR deserves to be taken down. When it rules
 * `TAKE DOWN`, the reason is posted as a comment on the task issue in the
 * tracker; a `KEEP` verdict only replies on the PR. The agent never touches
 * the forge itself, so nothing is closed or reverted automatically.
 */
async function respondToTakeDown(opts: RespondToMentionOptions, run: Exec): Promise<void> {
  const mk = opts.makeHarnessFn ?? makeHarness
  const wt = await prWorktree(opts, run)
  const outPath = join(tmpdir(), `amagi-takedown-${opts.pr.number}-${opts.mention.id}.md`)
  let verdict: string
  let reason: string
  try {
    const proc = startImplementHarness(
      mk,
      opts.config.harness.implement,
      wt.path,
      takeDownPrompt({
        pr: opts.pr,
        mention: opts.mention,
        outPath,
      }),
      takeDownSystemPrompt(),
    )
    const outcome = await proc.done
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

  await opts.driver.postComment(opts.root, opts.pr.number, reason)
  if (verdict !== 'TAKE DOWN') return
  if (opts.tracker === undefined) return

  const taskId = taskIdFromPrTitle(opts.pr.title)
  if (taskId === null) return
  const task = await opts.tracker.get(taskId)
  if (task === null) return
  await opts.tracker.comment(taskId, reason)
}

/** Responds to a single mention. Throws when the response fails so the caller can retry. */
export async function respondToMention(opts: RespondToMentionOptions): Promise<MentionKind> {
  const kind = classifyMention(opts.mention.body)
  const run = opts.exec ?? defaultExec
  switch (kind) {
    case 'fix':
      await respondToFix(opts, run)
      return 'fix'
    case 'explain':
      await respondToExplain(opts, run)
      return 'explain'
    case 'take-down':
      await respondToTakeDown(opts, run)
      return 'take-down'
    case 'ambiguous':
      await askClarification(opts)
      return 'ambiguous'
  }
}
