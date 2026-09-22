import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { forgeToken, ghEnv, gitTokenConfig } from './drivers/forge-cred.ts'
import { CommandError, exec as defaultExec, type Exec, execOk } from './exec.ts'
import { cacheHome } from './paths.ts'
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
  /** Label names, so the pointlessness pass can scope to the amagi provenance label. */
  labels: string[]
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

/**
 * Lists open PRs through gh. GitHub-only by design: the pollers and the
 * pointlessness pass that consume it share this binding rather than each
 * hammering a forge-specific endpoint.
 */
export async function listOpenPrs(opts: PrCheckOptions): Promise<PrInfo[]> {
  const run = opts.exec ?? defaultExec
  const out = await execOk(run, ['gh', 'pr', 'list', '--state', 'open', '--json', GH_FIELDS], {
    cwd: opts.cwd,
    env: ghEnv(),
  })
  const raw = JSON.parse(out) as Array<
    Omit<PrInfo, 'labels'> & { labels?: Array<{ name?: string }> }
  >
  // gh reports labels as objects; the pass only needs the names.
  return raw.map((pr) => ({ ...pr, labels: (pr.labels ?? []).map((l) => l.name ?? '') }))
}

export type FetchPullHeadsOptions = {
  repoRoot: string
  /** Last seen PR head SHAs keyed by ref (refs/pull/N/head), so the fetch is skipped when none moved. */
  lastHeads: Record<string, string>
  exec?: Exec
}

export type FetchPullHeadsResult = {
  /** True when a fetch ran because at least one PR head moved since lastHeads. */
  fetched: boolean
  /** Current PR head SHAs keyed by ref, e.g. refs/pull/7/head. */
  heads: Record<string, string>
}

/**
 * Mirrors every open PR head into refs/remotes/origin/pr/* with one fetch.
 * The pull/star/head namespace covers fork PRs, which a per-branch fetch of
 * headRefName does not. ls-remote is a zero-transfer zero-quota probe, so the
 * fetch is skipped on ticks where no head moved.
 */
export async function fetchPullHeads(opts: FetchPullHeadsOptions): Promise<FetchPullHeadsResult> {
  const run = opts.exec ?? defaultExec
  const tokenCfg = await gitTokenConfig(run, opts.repoRoot, 'origin', forgeToken('github'))

  const out = await execOk(run, ['git', ...tokenCfg, 'ls-remote', 'origin', 'refs/pull/*/head'], {
    cwd: opts.repoRoot,
  })
  const heads: Record<string, string> = {}
  for (const line of out.trim().split('\n')) {
    if (line === '') continue
    const [sha, ref] = line.split('\t')
    if (sha !== undefined && ref !== undefined) heads[ref] = sha
  }

  const moved =
    Object.keys(heads).length !== Object.keys(opts.lastHeads).length ||
    Object.keys(heads).some((ref) => opts.lastHeads[ref] !== heads[ref])
  if (!moved) return { fetched: false, heads }

  await execOk(
    run,
    [
      'git',
      ...tokenCfg,
      'fetch',
      '--prune',
      'origin',
      '+refs/pull/*/head:refs/remotes/origin/pr/*',
    ],
    { cwd: opts.repoRoot },
  )
  return { fetched: true, heads }
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

/** Pinned merge config so the local verdict is reproducible regardless of ambient git config. */
const MERGE_TREE_ARGS = [
  '-c',
  'merge.renames=true',
  '-c',
  'merge.conflictStyle=merge',
  '-c',
  'merge.directoryRenames=conflicts',
]

export type MergeTreeVerdict = 'clean' | 'conflict'

export type MergeTreeOptions = {
  repoRoot: string
  base: string
  head: string
  exec?: Exec
}

/**
 * Local conflict verdict for a PR via `git merge-tree --write-tree --quiet`:
 * no worktree, no index, bare-repo safe, and the same ort machinery as
 * `git merge`. Exit 0 is clean, exit 1 is conflict; any other non-zero exit
 * (a missing ref) is an error, never a verdict.
 */
export async function mergeTreeVerdict(opts: MergeTreeOptions): Promise<MergeTreeVerdict> {
  const run = opts.exec ?? defaultExec
  const cmd = [
    'git',
    ...MERGE_TREE_ARGS,
    'merge-tree',
    '--write-tree',
    '--quiet',
    opts.base,
    opts.head,
  ]
  const result = await run(cmd, { cwd: opts.repoRoot })
  if (result.exitCode === 0) return 'clean'
  if (result.exitCode === 1 && result.stderr === '') return 'conflict'
  throw new CommandError(cmd, result)
}

/**
 * Maps GitHub's `mergeable` onto the local verdict space. CONFLICTING and
 * MERGEABLE map 1:1 onto git; UNKNOWN is a third bucket, never a divergence.
 */
export function mergeableToVerdict(mergeable: string): MergeTreeVerdict | 'unknown' {
  if (mergeable === 'CONFLICTING') return 'conflict'
  if (mergeable === 'MERGEABLE') return 'clean'
  return 'unknown'
}

export type MergeTreeObservation = {
  pr: number
  headOid: string
  local: MergeTreeVerdict
  github: MergeTreeVerdict | 'unknown'
  timestamp: string
}

export function mergeTreeLogPath(repoName: string): string {
  return join(cacheHome(), 'amagi', 'merge-tree', `${repoName}.jsonl`)
}

/** Appends one observation; append-only, so the log stays a durable measurement trail. */
export function recordMergeTreeObservation(path: string, row: MergeTreeObservation): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(row)}\n`)
}
