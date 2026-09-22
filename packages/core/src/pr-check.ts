import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { forgeToken, ghEnv, gitTokenConfig } from './drivers/forge-cred.ts'
import type { TrackerTask } from './drivers/types.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { applyPersona, branchExists } from './worktree.ts'

export type PrInfo = {
  number: number
  title: string
  /** Full PR description, so the amagi-task trailer can be read back off it. */
  body: string
  url: string
  headRefName: string
  baseRefName: string
  mergeable: string
  mergeStateStatus: string
  /** Head commit SHA, so the conflict watcher can skip PRs whose head has not changed. */
  headRefOid: string | null
  /** Last activity timestamp, so pollers can skip PRs that have not changed. */
  updatedAt: string
  /** Label names, so the priority-label sync and pointlessness pass can read them off one list call. */
  labels: string[]
}

/** Priority labels stamped on amagi PRs, in dispatch order. */
export const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3', 'P4'] as const

export type PrCheckOptions = {
  cwd: string
  exec?: Exec
}

const GH_FIELDS =
  'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,updatedAt,labels'

/** GitHub marks a PR that cannot merge due to conflicts as CONFLICTING or DIRTY. */
export function isConflicting(pr: PrInfo, baseBranch: string): boolean {
  return (
    pr.baseRefName === baseBranch &&
    (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY')
  )
}

/**
 * Lists open PRs through gh. GitHub-only by design: the pollers, the
 * pointlessness pass, and the priority-label sync that consume it share this
 * binding rather than each hammering a forge-specific endpoint.
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
  // gh reports labels as objects; the passes only need the names.
  return raw.map((pr) => ({ ...pr, labels: (pr.labels ?? []).map((l) => l.name ?? '') }))
}

/** The task id in an amagi-authored branch `amagi/<id>-<slug>`, or null when the branch is not amagi's. */
export function taskIdFromPrBranch(headRefName: string): string | null {
  return headRefName.match(/^amagi\/([a-z]+-[a-z0-9.]+)-/)?.[1] ?? null
}

export type PrPriority = {
  number: number
  /** 0-4: the linked bead's priority, P4 when the bead is missing or closed. */
  priority: number
  /** The PR branch carries the amagi/<id>- prefix, so its labels are managed. */
  amagi: boolean
  /** An open linked bead exists, so its P<n> label is kept in sync. */
  linked: boolean
}

/** Resolve each amagi PR's linked bead priority from the tracker; anything unlinked is P4. */
export async function resolvePrPriorities(
  prs: PrInfo[],
  getTask: (id: string) => Promise<TrackerTask | null>,
): Promise<PrPriority[]> {
  return Promise.all(
    prs.map(async (p) => {
      const id = taskIdFromPrBranch(p.headRefName)
      if (id === null) return { number: p.number, priority: 4, amagi: false, linked: false }
      const task = await getTask(id)
      const linked = task !== null && task.status !== 'closed'
      return {
        number: p.number,
        priority: linked ? (task.priority ?? 4) : 4,
        amagi: true,
        linked,
      }
    }),
  )
}

export type SyncPrPriorityLabelOptions = {
  cwd: string
  number: number
  /** Labels already on the PR, from the list call. */
  labels: string[]
  /** Bead priority 0-4, or null to remove any P* label when the bead is gone or closed. */
  priority: number | null
  exec?: Exec
}

/**
 * Brings a PR's P<n> label in line with its bead priority: removes every stale
 * P0-P4 label, then adds the current one, creating it on demand. Writes are
 * best effort, like PR label creation, so a lost write does not kill the run.
 */
export async function syncPrPriorityLabel(opts: SyncPrPriorityLabelOptions): Promise<void> {
  const run = opts.exec ?? defaultExec
  const want = opts.priority === null ? null : `P${opts.priority}`
  const remove = PRIORITY_LABELS.filter((l) => l !== want && opts.labels.includes(l))
  if (remove.length > 0) {
    await run(
      ['gh', 'pr', 'edit', String(opts.number), ...remove.flatMap((l) => ['--remove-label', l])],
      { cwd: opts.cwd, env: ghEnv() },
    )
  }
  if (want !== null && !opts.labels.includes(want)) {
    await run(['gh', 'label', 'create', want, '--force'], { cwd: opts.cwd, env: ghEnv() })
    await run(['gh', 'pr', 'edit', String(opts.number), '--add-label', want], {
      cwd: opts.cwd,
      env: ghEnv(),
    })
  }
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
  } else {
    // A reused worktree can hold a stale in-progress merge or committed resolution
    // from an earlier run; abort and reset so the merge below starts from the PR head.
    await run(['git', 'merge', '--abort'], { cwd: path })
    await execOk(run, ['git', 'reset', '--hard', `origin/${opts.pr.headRefName}`], { cwd: path })
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
