import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { forgeToken, ghEnv, gitTokenConfig } from './drivers/forge-cred.ts'
import type { TrackerTask } from './drivers/types.ts'
import { CommandError, exec as defaultExec, type Exec, execOk } from './exec.ts'
import { cacheHome } from './paths.ts'
import { applyPersona, branchExists } from './worktree.ts'

export type PrInfo = {
  number: number
  title: string
  /** Full PR description, so the task id can be read back off it. */
  body: string
  url: string
  headRefName: string
  baseRefName: string
  mergeable: string
  mergeStateStatus: string
  /** Head commit SHA, so the conflict watcher can skip PRs whose head has not changed. */
  headRefOid: string | null
  /** Creation timestamp, used to prioritize newer conflicts first. */
  createdAt: string
  /** Last activity timestamp, so pollers can skip PRs that have not changed. */
  updatedAt: string
  /** Label names, so the priority-label sync and pointlessness pass can read them off one list call. */
  labels: string[]
}

/** Priority labels stamped on amagi PRs, in dispatch order. */
export const PRIORITY_LABELS = ['P0', 'P1', 'P2', 'P3', 'P4'] as const

export type PrCheckOptions = {
  cwd: string
  exec?: Exec | undefined
}

const GH_FIELDS =
  'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,createdAt,updatedAt,labels'

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
 * Adds labels to a PR through the REST issues endpoint, which creates missing
 * labels on the fly. Not `gh pr edit`: with amagi's token it never attached a
 * label, and its failures went unseen behind best-effort callers.
 */
export async function addPrLabels(
  run: Exec,
  cwd: string,
  number: number,
  labels: readonly string[],
): Promise<void> {
  await execOk(
    run,
    [
      'gh',
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/issues/${number}/labels`,
      '--input',
      '-',
    ],
    { cwd, stdin: JSON.stringify({ labels }), env: ghEnv() },
  )
}

/** Removes a label from a PR through the REST issues endpoint; a label already absent is not an error. */
export async function removePrLabel(
  run: Exec,
  cwd: string,
  number: number,
  label: string,
): Promise<void> {
  const cmd = [
    'gh',
    'api',
    '--method',
    'DELETE',
    `repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
  ]
  const r = await run(cmd, { cwd, env: ghEnv() })
  if (r.exitCode !== 0 && !/HTTP 404/.test(r.stderr)) throw new CommandError(cmd, r)
}

/**
 * Brings a PR's P<n> label in line with its bead priority: removes every stale
 * P0-P4 label, then adds the current one. Throws on a failed write so callers
 * can report it; each caller decides whether one PR's failure stops the rest.
 */
export async function syncPrPriorityLabel(opts: SyncPrPriorityLabelOptions): Promise<void> {
  const run = opts.exec ?? defaultExec
  const want = opts.priority === null ? null : `P${opts.priority}`
  for (const label of PRIORITY_LABELS) {
    if (label !== want && opts.labels.includes(label)) {
      await removePrLabel(run, opts.cwd, opts.number, label)
    }
  }
  if (want !== null && !opts.labels.includes(want)) {
    await addPrLabels(run, opts.cwd, opts.number, [want])
  }
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
export function taskIdFromAmagiBranch(branch: string): string | null {
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
  /** Explicit count when multiple dispatches share a stale PR snapshot. */
  iteration?: number
  exec?: Exec
}): Promise<StampedIteration | null> {
  const run = opts.exec ?? defaultExec
  const taskId = taskIdFromAmagiBranch(opts.pr.headRefName)
  if (taskId === null) return null
  const current = iterationsFromLabels(opts.pr.labels)
  const iteration = opts.iteration ?? current + 1
  await addPrLabels(run, opts.cwd, opts.pr.number, [iterationLabel(iteration)])
  if (current > 0 && current !== iteration) {
    await removePrLabel(run, opts.cwd, opts.pr.number, iterationLabel(current))
  }
  return { taskId, iteration }
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
  /**
   * The base commit that was merged. Compare against this, not origin/<base>:
   * the ref is shared with the operator's checkout and moves under a long run.
   */
  baseOid: string
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

  const baseOid = (
    await execOk(run, ['git', 'rev-parse', '--verify', `origin/${opts.baseBranch}^{commit}`], {
      cwd: opts.repoRoot,
    })
  ).trim()
  const merge = await run(
    ['git', 'merge', '-m', `Merge remote-tracking branch 'origin/${opts.baseBranch}'`, baseOid],
    { cwd: path },
  )
  return { path, branch, conflicted: merge.exitCode !== 0, baseOid }
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
