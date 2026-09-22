import {
  type Config,
  conflictWatchPath,
  type Exec,
  flagPointlessPrs,
  isConflicting,
  listOpenPrs,
  type makeHarness,
  type PrDriver,
  type ResolveConflictResult,
  readConflictWatch,
  resolveConflict,
  type Store,
  saveConflictWatch,
  type Tracker,
  type WorkerActivity,
} from '@amagi/core'

export type PrConflictWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  root: string
  repoName: string
  config: Config
  /** Store and tracker for the pointlessness pass, which parks and un-parks tasks. */
  store: Store
  tracker: Tracker
  /** Forge driver for the pointlessness pass's label and comment mutations. */
  driver: PrDriver
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

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The shared PR watcher: one listOpenPrs per tick feeds the conflict and
 * pointlessness passes over the same list, so no fourth poll loop hammers the
 * endpoint. Conflicts are resolved one per head SHA; amagi PRs whose diff
 * against base is empty get flagged (label + comments, task parked in
 * pr_flagged), and a flag is cleared once real commits arrive. Ticks are
 * sequential: a long resolution delays the next scan rather than stacking on
 * top of it.
 */
export function startPrConflictWatcher({
  repo,
  root,
  repoName,
  config,
  store,
  tracker,
  driver,
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
  let flagged = 0
  let cleared = 0
  const counters = (): WorkerActivity['counters'] => [
    { label: 'scanned', value: scanned },
    { label: 'conflicting', value: conflicting },
    { label: 'resolved', value: resolved },
    { label: 'flagged', value: flagged },
    { label: 'cleared', value: cleared },
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
      const pointless = await flagPointlessPrs({
        store,
        tracker,
        driver,
        cwd: root,
        repoName,
        prs,
        ...(exec === undefined ? {} : { exec }),
      })
      flagged += pointless.flagged
      cleared += pointless.cleared
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
