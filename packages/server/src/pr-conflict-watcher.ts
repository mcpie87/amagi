import {
  type Config,
  type ConflictWatchState,
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
  type MergeTreeVerdict,
  type makeHarness,
  mergeableToVerdict,
  mergeTreeLogPath,
  mergeTreeVerdict,
  type PrDriver,
  type PrInfo,
  type PrPriority,
  type ResolveConflictResult,
  readConflictWatch,
  recordMergeTreeObservation,
  resolveConflict,
  resolvePrPriorities,
  type Store,
  saveConflictWatch,
  syncPrPriorityLabel,
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
  exec?: Exec | undefined
  makeHarnessFn?: typeof makeHarness | undefined
}

export type PrConflictWatcher = {
  stop(): void
  activity(): WorkerActivity
}

const DEFAULT_INTERVAL_MS = 300_000

/**
 * The shared PR watcher: one listOpenPrs per tick feeds the conflict and
 * pointlessness passes over the same list, so no fourth poll loop hammers the
 * endpoint. Conflicts are resolved once per (PR head, base head) pair, so a
 * failed attempt is retried when either side moves; a PR whose work base
 * already contains is only re-armed by a new PR head. Amagi PRs whose diff
 * against base is empty, or whose work base already contains, get flagged
 * (label + comments, task parked in pr_flagged), and a flag is cleared once
 * real commits arrive. Each tick also keeps amagi PRs' P<n> labels on their
 * bead priority. Ticks are sequential: a long resolution delays the next scan
 * rather than stacking on top of it.
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
  let log: NonNullable<WorkerActivity['log']> = []
  const logEvent = (message: string, level: 'info' | 'error' = 'info'): void => {
    log = [...log, { ts: Date.now(), message, level }].slice(-100)
    activity = { ...activity, log }
  }
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
   * `git merge-tree` verdict against the forge's `mergeable` and append one row
   * per PR to the observation JSONL. Dispatch never reads these verdicts.
   * UNKNOWN is a third bucket, never a divergence; up to two UNKNOWN PRs per
   * tick are forced through the driver so the mergeability job resolves
   * round-robin and coverage accrues without a tenfold call increase.
   */
  async function observeMergeTree(prs: PrInfo[], run: Exec, runId: string): Promise<void> {
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
        const status = await driver.getMergeStatus(root, p.number)
        forced.set(
          p.number,
          status === 'conflicted'
            ? 'CONFLICTING'
            : status === 'mergeable'
              ? 'MERGEABLE'
              : 'UNKNOWN',
        )
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
        logEvent(`PR #${p.number}: merge-tree check failed: ${errMsg(err)}`, 'error')
        store.append(null, {
          type: 'watcher.action',
          repo,
          name: 'pr-conflict-watcher',
          runId,
          targetType: 'pr',
          targetId: String(p.number),
          prNumber: p.number,
          url: p.url,
          result: `merge-tree check failed: ${errMsg(err)}`,
          level: 'error',
        })
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

  /** The base branch's remote head, so a base move re-arms PRs already attempted. */
  async function baseHeadOid(run: Exec): Promise<string> {
    const tokenCfg = await gitTokenConfig(run, root, 'origin', forgeToken('github'))
    const ref = `refs/heads/${config.repo.baseBranch}`
    const out = await execOk(run, ['git', ...tokenCfg, 'ls-remote', 'origin', ref], { cwd: root })
    return (
      out
        .split('\n')
        .map((line) => line.split('\t'))
        .find(([, name]) => name === ref)?.[0] ?? ''
    )
  }

  /** Keeps each amagi PR's P<n> label on its bead priority; one PR's failed write never stops the rest. */
  async function syncPriorityLabels(prs: PrInfo[], runId: string): Promise<void> {
    let priorities: PrPriority[]
    try {
      priorities = await resolvePrPriorities(prs, (id) => tracker.get(id))
    } catch (err) {
      logEvent(`priority lookup failed: ${errMsg(err)}`, 'error')
      return
    }
    for (const [i, pr] of prs.entries()) {
      const pri = priorities[i]
      if (pri === undefined || !pri.amagi) continue
      try {
        await syncPrPriorityLabel({
          cwd: root,
          number: pr.number,
          labels: pr.labels,
          priority: pri.linked ? pri.priority : null,
          ...(exec === undefined ? {} : { exec }),
        })
      } catch (err) {
        logEvent(`PR #${pr.number}: priority label sync failed: ${errMsg(err)}`, 'error')
        store.append(null, {
          type: 'watcher.action',
          repo,
          name: 'pr-conflict-watcher',
          runId,
          targetType: 'pr',
          targetId: String(pr.number),
          prNumber: pr.number,
          url: pr.url,
          result: `priority label sync failed: ${errMsg(err)}`,
          level: 'error',
        })
      }
    }
  }

  async function tick(): Promise<void> {
    runs++
    const runId = `${Date.now()}-${runs}`
    store.append(null, { type: 'watcher.run.started', repo, name: 'pr-conflict-watcher', runId })
    logEvent(`run ${runs} started`)
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
      const prs = await driver.listOpenPrs(root)
      scanned = prs.length
      if (config.loop.mergeTreeCheck) {
        // Observation never blocks dispatch: a failed audit is logged and skipped.
        try {
          await observeMergeTree(prs, run, runId)
        } catch (err) {
          logEvent(`merge-tree observation failed: ${errMsg(err)}`, 'error')
          console.warn(`merge-tree observation: ${errMsg(err)}`)
        }
      }
      const statePath = conflictWatchPath(repoName)
      const state = readConflictWatch(statePath)
      const nextState: ConflictWatchState = {}
      const conflicts = prs.filter((p) => isConflicting(p, config.repo.baseBranch))
      conflicting = conflicts.length
      if (conflicts.length > 0) logEvent(`found ${conflicts.length} conflicting PR(s)`)
      const baseOid = conflicts.length > 0 ? await baseHeadOid(run) : ''
      let resolvedNow = 0
      const warnings: string[] = []
      for (const pr of conflicts) {
        const key = String(pr.number)
        const headOid = pr.headRefOid ?? ''
        const seen = state[key]
        if (
          seen !== undefined &&
          seen.headOid === headOid &&
          (seen.baseOid === baseOid || seen.contained === true)
        ) {
          nextState[key] = seen
          continue
        }
        const result: ResolveConflictResult = await resolveConflict({
          repo,
          repoRoot: root,
          repoName,
          pr,
          config,
          driver,
          store,
          exec,
          makeHarnessFn,
          onGitBypassed: (entries) => store.append(null, { type: 'git.bypassed', entries }),
        })
        nextState[key] = {
          headOid,
          baseOid,
          ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
          ...(result.contained ? { contained: true } : {}),
        }
        if (result.verdict?.verdict && result.verdict.verdict !== 'RESOLVED') {
          console.warn(`pr conflict #${pr.number}: agent verdict ${result.verdict.verdict}`)
          warnings.push(`#${pr.number}: agent verdict ${result.verdict.verdict}`)
        }
        if (result.ok) {
          resolved++
          resolvedNow++
          logEvent(`PR #${pr.number}: conflict resolution dispatched`)
          store.append(null, {
            type: 'watcher.action',
            repo,
            name: 'pr-conflict-watcher',
            runId,
            targetType: 'pr',
            targetId: String(pr.number),
            prNumber: pr.number,
            url: pr.url,
            result: 'conflict resolution dispatched',
            level: 'info',
          })
        } else {
          logEvent(`PR #${pr.number}: ${result.message}`, 'error')
          store.append(null, {
            type: 'watcher.action',
            repo,
            name: 'pr-conflict-watcher',
            runId,
            targetType: 'pr',
            targetId: String(pr.number),
            prNumber: pr.number,
            url: pr.url,
            result: result.message,
            level: 'error',
          })
          console.warn(`pr conflict #${pr.number}: ${result.message}`)
          warnings.push(`#${pr.number}: ${result.message}`)
        }
      }
      // Only PRs that are still conflicting stay tracked; the rest drop out.
      saveConflictWatch(statePath, nextState)
      const contained = new Map(
        conflicts
          .filter((p) => nextState[String(p.number)]?.contained === true)
          .map((p) => [p.number, nextState[String(p.number)]?.verdict ?? null]),
      )
      const pointless = await flagPointlessPrs({
        store,
        tracker,
        driver,
        cwd: root,
        repoName,
        prs,
        config,
        contained,
        ...(exec === undefined ? {} : { exec }),
        ...(makeHarnessFn === undefined ? {} : { makeHarnessFn }),
        onAction: (pr, result, level) =>
          store.append(null, {
            type: 'watcher.action',
            repo,
            name: 'pr-conflict-watcher',
            runId,
            targetType: 'pr',
            targetId: String(pr.number),
            prNumber: pr.number,
            url: pr.url,
            result,
            level,
          }),
      })
      flagged += pointless.flagged
      cleared += pointless.cleared
      await syncPriorityLabels(prs, runId)
      next.detail = `found ${conflicts.length} conflicting PRs, resolved ${resolvedNow}${
        warnings.length === 0 ? '' : `; warnings: ${warnings.join('; ')}`
      }`
      logEvent(`run ${runs} completed: scanned ${prs.length} PRs, ${next.detail}`)
    } catch (err) {
      failures++
      next.ok = false
      next.error = errMsg(err)
      next.failures = failures
      next.successes = runs - failures
      next.detail = 'scan failed'
      logEvent(`run ${runs} failed: ${next.error}`, 'error')
      console.warn(`pr conflict watch: ${next.error}`)
    }
    next.counters = counters()
    next.log = log
    activity = next
    try {
      store.append(null, {
        type: 'watcher.run.finished',
        repo,
        name: 'pr-conflict-watcher',
        runId,
        ok: next.ok,
        error: next.error,
      })
    } catch (err) {
      console.warn(`pr conflict watcher history: ${errMsg(err)}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  void tick()
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
