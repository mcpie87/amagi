import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { forgeToken, ghEnv, gitTokenConfig } from './drivers/forge-cred.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { applyPersona, branchExists } from './worktree.ts'

export type PrInfo = {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName: string
  mergeable: string
  mergeStateStatus: string
  /** Head commit SHA, so the conflict watcher can skip PRs whose head has not changed. */
  headRefOid: string | null
  /** Last activity timestamp, so pollers can skip PRs that have not changed. */
  updatedAt: string
  /** Label names; filled by listOpenPrs, absent in hand-built fixtures. */
  labels?: string[]
}

export type PrCheckOptions = {
  cwd: string
  exec?: Exec
}

const GH_FIELDS =
  'number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,updatedAt,labels'

/** GitHub marks a PR that cannot merge due to conflicts as CONFLICTING or DIRTY. */
export function isConflicting(pr: PrInfo, baseBranch: string): boolean {
  return (
    pr.baseRefName === baseBranch &&
    (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY')
  )
}

export async function listOpenPrs(opts: PrCheckOptions): Promise<PrInfo[]> {
  const run = opts.exec ?? defaultExec
  const out = await execOk(run, ['gh', 'pr', 'list', '--state', 'open', '--json', GH_FIELDS], {
    cwd: opts.cwd,
    env: ghEnv(),
  })
  const raw = JSON.parse(out) as Array<
    Omit<PrInfo, 'labels'> & { labels?: Array<{ name: string }> }
  >
  return raw.map((p) => ({ ...p, labels: (p.labels ?? []).map((l) => l.name) }))
}

/** Label counting how many times a conflicting PR has been re-resolved. */
export const ITERATION_LABEL_PREFIX = 'amagi/iterations:'

export function iterationLabel(n: number): string {
  return `${ITERATION_LABEL_PREFIX}${n}`
}

/** The amagi/iterations:N count in a PR's labels, 0 when absent or unparseable. */
export function iterationsFromLabels(labels: readonly string[] | undefined): number {
  if (labels === undefined) return 0
  const hit = labels.find((l) => l.startsWith(ITERATION_LABEL_PREFIX))
  if (hit === undefined) return 0
  const n = Number(hit.slice(ITERATION_LABEL_PREFIX.length))
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** The task id an amagi PR's head branch encodes (`amagi/<id>-...`), null for non-amagi PRs. */
export function taskIdFromBranch(branch: string): string | null {
  return branch.match(/^amagi\/(am-[a-z0-9.]+)/)?.[1] ?? null
}

export type StampedIteration = {
  taskId: string
  iteration: number
}

/**
 * Bumps a conflicting amagi PR's resolution counter: reads the current
 * amagi/iterations:N label (0 when absent), stamps amagi/iterations:N+1 on the
 * PR, and reports the new count so the caller can mirror it onto the linked
 * bead. Returns null for non-amagi PRs, which carry no iteration label.
 */
export async function stampIterationLabel(opts: {
  cwd: string
  pr: PrInfo
  exec?: Exec
}): Promise<StampedIteration | null> {
  const run = opts.exec ?? defaultExec
  const taskId = taskIdFromBranch(opts.pr.headRefName)
  if (taskId === null) return null
  const current = iterationsFromLabels(opts.pr.labels)
  const iteration = current + 1
  await execOk(run, ['gh', 'label', 'create', iterationLabel(iteration), '--force'], {
    cwd: opts.cwd,
    env: ghEnv(),
  })
  const edit = [
    'gh',
    'pr',
    'edit',
    String(opts.pr.number),
    '--add-label',
    iterationLabel(iteration),
  ]
  if (current > 0) edit.push('--remove-label', iterationLabel(current))
  await execOk(run, edit, { cwd: opts.cwd, env: ghEnv() })
  return { taskId, iteration }
}

export type PrepareConflictWorktreeOptions = {
  repoRoot: string
  repoName: string
  worktreeRoot: string
  baseBranch: string
  pr: PrInfo
  /** Git persona name; the matching ~/.config/git/personas/<name>.gitconfig is included. */
  persona?: string | null
  exec?: Exec
}

export type ConflictWorktree = {
  path: string
  branch: string
  /** False when baseBranch merges cleanly, so the agent has nothing to resolve. */
  conflicted: boolean
}

/**
 * Checks out the PR head in a worktree and merges baseBranch into it. A
 * non-zero merge exit leaves conflicts in the tree for an agent to resolve.
 * Idempotent: an existing worktree for the same PR number is reused.
 */
export async function prepareConflictWorktree(
  opts: PrepareConflictWorktreeOptions,
): Promise<ConflictWorktree> {
  const run = opts.exec ?? defaultExec
  const tokenCfg = await gitTokenConfig(run, opts.repoRoot, 'origin', forgeToken('github'))

  await execOk(run, ['git', ...tokenCfg, 'fetch', 'origin', opts.baseBranch], {
    cwd: opts.repoRoot,
  })
  await execOk(run, ['git', ...tokenCfg, 'fetch', 'origin', opts.pr.headRefName], {
    cwd: opts.repoRoot,
  })

  const branch = `amagi/pr-${opts.pr.number}-conflict`
  const path = join(opts.worktreeRoot, `${opts.repoName}-pr-${opts.pr.number}`)

  if (!existsSync(path)) {
    const exists = await branchExists(run, opts.repoRoot, branch)
    const args = exists
      ? ['git', 'worktree', 'add', path, branch]
      : ['git', 'worktree', 'add', '-b', branch, path, `origin/${opts.pr.headRefName}`]
    await execOk(run, args, { cwd: opts.repoRoot })
  }

  if (opts.persona) {
    await applyPersona(run, path, opts.persona)
  }

  const merge = await run(['git', 'merge', `origin/${opts.baseBranch}`], { cwd: path })
  return { path, branch, conflicted: merge.exitCode !== 0 }
}

export type PushConflictFixOptions = {
  cwd: string
  branch: string
  headRef: string
  remote: string
  exec?: Exec
}

/** Pushes the resolved local branch back to the PR head ref, updating the PR. */
export async function pushConflictFix(opts: PushConflictFixOptions): Promise<void> {
  const run = opts.exec ?? defaultExec
  const tokenCfg = await gitTokenConfig(run, opts.cwd, opts.remote, forgeToken('github'))
  await execOk(
    run,
    ['git', ...tokenCfg, 'push', opts.remote, `${opts.branch}:refs/heads/${opts.headRef}`],
    { cwd: opts.cwd },
  )
}

export type PrMergeStatus = {
  mergeable: string
  mergeStateStatus: string
}

/**
 * Reads a PR's merge status. GitHub computes mergeability asynchronously: bulk
 * queries (`gh pr list`) report UNKNOWN until a single-PR query triggers it, so
 * retry briefly until the state resolves.
 */
export async function prMergeStatus(
  cwd: string,
  number: number,
  exec?: Exec,
): Promise<PrMergeStatus> {
  const run = exec ?? defaultExec
  let status: PrMergeStatus = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
  for (let attempt = 0; attempt < 5; attempt++) {
    const out = await execOk(
      run,
      ['gh', 'pr', 'view', String(number), '--json', 'mergeable,mergeStateStatus'],
      { cwd, env: ghEnv() },
    )
    status = JSON.parse(out) as PrMergeStatus
    if (status.mergeable !== 'UNKNOWN' && status.mergeStateStatus !== 'UNKNOWN') break
    if (attempt < 4) await Bun.sleep(1000)
  }
  return status
}
