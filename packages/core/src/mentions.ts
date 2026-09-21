import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import type { PrComment, PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Tracker } from './drivers/types.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
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
  /** Tracker used by the add-a-task response; optional so callers without one still work. */
  tracker?: Tracker
  exec?: Exec
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness
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
    'Do you want me to change the code (fix something), are you asking me to explain the changes, or should I log it as a new task? Please clarify.',
  ].join('\n\n')
  await opts.driver.postComment(opts.root, opts.pr.number, question)
}

/** Lets the LLM decide the response path, rather than assuming a fixed one. */
async function classifyMention(opts: RespondToMentionOptions): Promise<MentionKind> {
  const mk = opts.makeHarnessFn ?? makeHarness
  // A throwaway cwd: classification needs no repo context and must not touch one.
  const proc = startImplementHarness(
    mk,
    opts.config.harness.implement,
    tmpdir(),
    classifyMentionPrompt({ pr: opts.pr, mention: opts.mention }),
    classifyMentionSystemPrompt(),
  )
  const outcome = await proc.done
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

async function respondToAddTask(opts: RespondToMentionOptions): Promise<void> {
  const tracker = opts.tracker
  if (tracker === undefined || !tracker.capabilities.create) {
    await opts.driver.postComment(
      opts.root,
      opts.pr.number,
      `@${opts.mention.user} I'd log this as a task, but the configured tracker (${tracker?.kind ?? 'none'}) can't create issues.`,
    )
    return
  }
  const task = await tracker.createTask({
    title: addTaskTitle(opts),
    description: [
      `From @${opts.mention.user} on PR #${opts.pr.number} "${opts.pr.title}" (${opts.pr.url}):`,
      '',
      opts.mention.body.trim(),
    ].join('\n'),
    acceptanceCriteria: null,
    priority: null,
    labels: [],
    dependencies: [],
  })
  const where = task.url ?? `task ${task.id}`
  await opts.driver.postComment(
    opts.root,
    opts.pr.number,
    `@${opts.mention.user} Logged this as ${where}.`,
  )
}

/** Responds to a single mention. Throws when the response fails so the caller can retry. */
export async function respondToMention(opts: RespondToMentionOptions): Promise<MentionKind> {
  const run = opts.exec ?? defaultExec
  const kind = await classifyMention(opts)
  switch (kind) {
    case 'fix-pr':
      await respondToFix(opts, run)
      return 'fix-pr'
    case 'explain':
      await respondToExplain(opts, run)
      return 'explain'
    case 'add-a-task':
      await respondToAddTask(opts)
      return 'add-a-task'
    case 'ambiguous':
      await askClarification(opts)
      return 'ambiguous'
  }
}
