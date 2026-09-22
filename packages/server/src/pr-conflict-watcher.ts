import {
  type Config,
  conflictWatchPath,
  type Exec,
  errMsg,
  fetchPullHeads,
  isConflicting,
  listOpenPrs,
  type makeHarness,
  type ResolveConflictResult,
  readConflictWatch,
  resolveConflict,
  saveConflictWatch,
  type WorkerActivity,
} from '@amagi/core'

export type PrConflictWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  root: string
  repoName: string
  config: Config
  intervalMs?: number
  /** Test seams, forwarded to the resolver. */
  exec?: Exec
  makeHarnessFn?: typeof makeHarness
}

export type PrConflictWatcher = {
  stop(): void
  activity(): WorkerActivity
}

const DEFAULT_INTERVAL_MS = 300_000

/**
 * Continuously resolves open PRs that conflict with the base branch, one per
 * head SHA: a PR is only attempted once until its head commit changes, so an
 * unresolvable conflict cannot burn a full agent run every tick. Per-PR state
 * is kept on disk (the analogue of the mention watcher's last-seen tracking)
 * and dropped once the PR leaves the conflicting set. Ticks are sequential: a
 * long resolution delays the next scan rather than stacking on top of it.
 */
export function startPrConflictWatcher({
  repo,
  root,
  repoName,
  config,
  intervalMs = DEFAULT_INTERVAL_MS,
  exec,
  makeHarnessFn,
}: PrConflictWatcherOptions): PrConflictWatcher {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Cumulative across ticks, so the dashboard counters keep rising. */
  let scanned = 0
  let conflicting = 0
  let resolved = 0
  /** Last seen PR head SHAs, so the per-tick fetch is skipped when none moved. */
  let lastPullHeads: Record<string, string> = {}
  const counters = (): WorkerActivity['counters'] => [
    { label: 'scanned', value: scanned },
    { label: 'conflicting', value: conflicting },
    { label: 'resolved', value: resolved },
  ]
  let activity: WorkerActivity = {
    repo,
    name: 'pr-conflict-watcher',
    lastRunAt: 0,
    ok: true,
    error: null,
    counters: counters(),
  }

  async function tick(): Promise<void> {
    const next: WorkerActivity = { ...activity, lastRunAt: Date.now(), ok: true, error: null }
    try {
      const heads = await fetchPullHeads({
        repoRoot: root,
        lastHeads: lastPullHeads,
        ...(exec === undefined ? {} : { exec }),
      })
      lastPullHeads = heads.heads
      const prs = await listOpenPrs({ cwd: root, ...(exec === undefined ? {} : { exec }) })
      scanned = prs.length
      const statePath = conflictWatchPath(repoName)
      const state = readConflictWatch(statePath)
      const nextState: Record<string, { headOid: string }> = {}
      const conflicts = prs.filter((p) => isConflicting(p, config.repo.baseBranch))
      conflicting = conflicts.length
      for (const pr of conflicts) {
        const key = String(pr.number)
        const headOid = pr.headRefOid ?? ''
        const seen = state[key]
        if (seen !== undefined && seen.headOid === headOid) {
          nextState[key] = seen
          continue
        }
        const result: ResolveConflictResult = await resolveConflict({
          repoRoot: root,
          repoName,
          pr,
          config,
          ...(exec === undefined ? {} : { exec }),
          ...(makeHarnessFn === undefined ? {} : { makeHarnessFn }),
        })
        nextState[key] = { headOid }
        if (result.ok) {
          resolved++
        } else {
          console.warn(`pr conflict #${pr.number}: ${result.message}`)
        }
      }
      // Only PRs that are still conflicting stay tracked; the rest drop out.
      saveConflictWatch(statePath, nextState)
    } catch (err) {
      next.ok = false
      next.error = errMsg(err)
      console.warn(`pr conflict watch: ${next.error}`)
    }
    next.counters = counters()
    activity = next
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    activity: () => activity,
  }
}
