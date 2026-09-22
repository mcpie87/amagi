import {
  type Config,
  conflictWatchPath,
  exec as defaultExec,
  type Exec,
  errMsg,
  execOk,
  fetchPullHeads,
  flagPointlessPrs,
  forgeToken,
  gitTokenConfig,
  isConflicting,
  listOpenPrs,
  type MergeTreeVerdict,
  type makeHarness,
  mergeableToVerdict,
  mergeTreeLogPath,
  mergeTreeVerdict,
  type PrDriver,
  type PrInfo,
  prMergeStatus,
  type ResolveConflictResult,
  readConflictWatch,
  recordMergeTreeObservation,
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
  /** Last seen PR head SHAs, so the per-tick fetch is skipped when none moved. */
  let lastPullHeads: Record<string, string> = {}
  let runs = 0
  let failures = 0
  let flagged = 0
  let cleared = 0
  /** PRs whose local merge-tree verdict disagreed with GitHub's mergeable, cumulative. */
  let divergent = 0
  /** Round-robin cursor into the UNKNOWN PRs, so forced resolution cycles across them. */
  let unknownCursor = 0
  const counters = (): WorkerActivity['counters'] => [
    { label: 'scanned', value: scanned },
    { label: 'conflicting', value: conflicting },
    { label: 'resolved', value: resolved },
    { label: 'divergent', value: divergent },
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
    detail: 'waiting for the first scan',
    runs: 0,
    successes: 0,
    failures: 0,
    nextRunAt: 0,
    intervalMs,
    status: 'idle',
  }

  /**
   * Observation-only audit: for every open PR, compare the local
   * `git merge-tree` verdict against GitHub's `mergeable` and append one row
   * per PR to the observation JSONL. Dispatch never reads these verdicts.
   * UNKNOWN is a third bucket, never a divergence; up to two UNKNOWN PRs per
   * tick are forced through `prMergeStatus` so the mergeability job resolves
   * round-robin and coverage accrues without a tenfold call increase.
   */
  async function observeMergeTree(prs: PrInfo[], run: Exec): Promise<void> {
    const baseRefs = [...new Set(prs.map((p) => p.baseRefName))]
    const tokenCfg = await gitTokenConfig(run, root, 'origin', forgeToken('github'))
    for (const base of baseRefs) {
      await execOk(run, ['git', ...tokenCfg, 'fetch', 'origin', base], { cwd: root })
    }
    const forced = new Map<number, string>()
    const unknown = prs.filter((p) => p.mergeable === 'UNKNOWN')
    if (unknown.length > 0) {
      const start = unknownCursor % unknown.length
      for (let i = 0; i < 2 && i < unknown.length; i++) {
        const p = unknown[(start + i) % unknown.length]
        if (p === undefined) continue
        const status = await prMergeStatus(root, p.number, run)
        forced.set(p.number, status.mergeable)
      }
      unknownCursor += 2
    }
    const logPath = mergeTreeLogPath(repoName)
    for (const p of prs) {
      let local: MergeTreeVerdict
      try {
        local = await mergeTreeVerdict({
          repoRoot: root,
          base: `origin/${p.baseRefName}`,
          head: `refs/remotes/origin/pr/${p.number}/head`,
          exec: run,
        })
      } catch (err) {
        console.warn(`merge-tree #${p.number}: ${errMsg(err)}`)
        continue
      }
      const github = mergeableToVerdict(forced.get(p.number) ?? p.mergeable)
      recordMergeTreeObservation(logPath, {
        pr: p.number,
        headOid: p.headRefOid ?? '',
        local,
        github,
        timestamp: new Date().toISOString(),
      })
      if (github !== 'unknown' && github !== local) divergent++
    }
  }

  async function tick(): Promise<void> {
    runs++
    const next: WorkerActivity = {
      ...activity,
      lastRunAt: Date.now(),
      ok: true,
      error: null,
      runs,
      successes: runs - failures,
      failures,
      nextRunAt: Date.now() + intervalMs,
      intervalMs,
      status: 'active',
    }
    try {
      const run = exec ?? defaultExec
      const heads = await fetchPullHeads({
        repoRoot: root,
        lastHeads: lastPullHeads,
        ...(exec === undefined ? {} : { exec }),
      })
      lastPullHeads = heads.heads
      const prs = await listOpenPrs({ cwd: root, ...(exec === undefined ? {} : { exec }) })
      scanned = prs.length
      if (config.loop.mergeTreeCheck) {
        // Observation never blocks dispatch: a failed audit is logged and skipped.
        try {
          await observeMergeTree(prs, run)
        } catch (err) {
          console.warn(`merge-tree observation: ${errMsg(err)}`)
        }
      }
      const statePath = conflictWatchPath(repoName)
      const state = readConflictWatch(statePath)
      const nextState: Record<string, { headOid: string }> = {}
      const conflicts = prs.filter((p) => isConflicting(p, config.repo.baseBranch))
      conflicting = conflicts.length
      let resolvedNow = 0
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
          resolvedNow++
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
      next.detail = `found ${conflicts.length} conflicting PRs, resolved ${resolvedNow}`
    } catch (err) {
      failures++
      next.ok = false
      next.error = errMsg(err)
      next.failures = failures
      next.successes = runs - failures
      next.detail = 'scan failed'
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
      activity = { ...activity, status: 'off', nextRunAt: 0 }
    },
    activity: () => activity,
  }
}
