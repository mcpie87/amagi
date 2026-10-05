import {
  type Config,
  type ConflictWatchState,
  canTransition,
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
  PR_TASK_STATES,
  PRIMARY_FORGE,
  type PrDriver,
  type PrForge,
  type PrInfo,
  type PrPriority,
  prForgeRouter,
  type ResolveConflictResult,
  readConflictWatch,
  recordMergeTreeObservation,
  resolveConflict,
  resolvePrPriorities,
  type Store,
  saveConflictWatch,
  syncPrPriorityLabel,
  type Tracker,
  taskIdFromPrBranch,
  type WorkerActivity,
} from '@amagi/core'
import { startPoller } from './poller.ts'

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
  /** Routes task PR URLs to their forges; defaults to matching them against the repo's git remotes. */
  forgeFor?: ((prUrl: string | null) => PrForge) | undefined
  intervalMs?: number
  /** Test seams, forwarded to the resolver. */
  exec?: Exec | undefined
  makeHarnessFn?: typeof makeHarness | undefined
}

export type PrConflictWatcher = {
  stop(): void
  activity(): WorkerActivity
  /** Queues a manual resolution; `prUrl` routes it to the forge the PR lives on. */
  queue(prNumber: number, prUrl?: string | null): void
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
  forgeFor = prForgeRouter(root, config, driver),
  intervalMs = DEFAULT_INTERVAL_MS,
  exec,
  makeHarnessFn,
}: PrConflictWatcherOptions): PrConflictWatcher {
  /** Cumulative across ticks, so the dashboard counters keep rising. */
  let scanned = 0
  let conflicting = 0
  let resolved = 0
  /** Last seen PR head SHAs, so the per-tick fetch is skipped when none moved. */
  const lastPullHeads = new Map<string, Record<string, string>>()
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
  /** Conflict-watch state keys queued for a manual resolution run. */
  const queuedPrs = new Set<string>()
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
  async function observeMergeTree(
    prs: PrInfo[],
    run: Exec,
    runId: string,
    forge: PrForge,
  ): Promise<void> {
    const baseRefs = [...new Set(prs.map((p) => p.baseRefName))]
    const { kind, remote } = forge.config.forge
    const tokenCfg = await gitTokenConfig(run, root, remote, forgeToken(kind, root))
    for (const base of baseRefs) {
      await execOk(run, ['git', 'fetch', remote, base], {
        cwd: root,
        env: tokenCfg,
      })
    }
    const forced = new Map<number, string>()
    const unknown = prs.filter((p) => p.mergeable === 'UNKNOWN')
    if (unknown.length > 0) {
      const start = unknownCursor % unknown.length
      for (let i = 0; i < 2 && i < unknown.length; i++) {
        const p = unknown[(start + i) % unknown.length]
        if (p === undefined) continue
        const status = await forge.driver.getMergeStatus(root, p.number)
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
          base: `${remote}/${p.baseRefName}`,
          head: `refs/remotes/${remote}/pr/${p.number}/head`,
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
  async function baseHeadOid(run: Exec, forge: PrForge): Promise<string> {
    const { kind, remote } = forge.config.forge
    const tokenCfg = await gitTokenConfig(run, root, remote, forgeToken(kind, root))
    const ref = `refs/heads/${forge.config.repo.baseBranch}`
    const out = await execOk(run, ['git', 'ls-remote', remote, ref], {
      cwd: root,
      env: tokenCfg,
    })
    return (
      out
        .split('\n')
        .map((line) => line.split('\t'))
        .find(([, name]) => name === ref)?.[0] ?? ''
    )
  }

  /** Keeps each amagi PR's P<n> label on its bead priority; one PR's failed write never stops the rest. */
  async function syncPriorityLabels(prs: PrInfo[], runId: string, forge: PrForge): Promise<void> {
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
          remote: forge.config.forge.remote,
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

  /** Conflict-watch state key: bare PR numbers on the configured forge, `<forge>#<n>` elsewhere. */
  const stateKey = (forge: PrForge, prNumber: number): string =>
    forge.key === PRIMARY_FORGE ? String(prNumber) : `${forge.key}#${prNumber}`
  const ownsKey = (forge: PrForge, key: string): boolean =>
    forge.key === PRIMARY_FORGE ? /^\d+$/.test(key) : key.startsWith(`${forge.key}#`)

  /** The configured forge, plus every other forge a live task's PR was opened on. */
  function forgesToScan(): PrForge[] {
    const forges = new Map<string, PrForge>()
    const primary = forgeFor(null)
    forges.set(primary.key, primary)
    for (const task of store.tasks({ states: PR_TASK_STATES })) {
      const forge = forgeFor(task.prUrl)
      if (!forges.has(forge.key)) forges.set(forge.key, forge)
    }
    return [...forges.values()]
  }

  type ScanResult = {
    scanned: number
    conflicting: number
    resolvedNow: number
    warnings: string[]
  }

  /** One forge's pass: conflicts, merge-tree audit, pointlessness and priority labels. */
  async function scanForge(
    forge: PrForge,
    run: Exec,
    runId: string,
    queuedNow: ReadonlySet<string>,
  ): Promise<ScanResult> {
    const { config: forgeConfig, driver: forgeDriver } = forge
    const heads = await fetchPullHeads({
      repoRoot: root,
      remote: forgeConfig.forge.remote,
      forgeKind: forgeConfig.forge.kind,
      lastHeads: lastPullHeads.get(forge.key) ?? {},
      ...(exec === undefined ? {} : { exec }),
    })
    lastPullHeads.set(forge.key, heads.heads)
    const prs = await forgeDriver.listOpenPrs(root)
    if (forgeConfig.loop.mergeTreeCheck) {
      // Observation never blocks dispatch: a failed audit is logged and skipped.
      try {
        await observeMergeTree(prs, run, runId, forge)
      } catch (err) {
        logEvent(`merge-tree observation failed: ${errMsg(err)}`, 'error')
        console.warn(`merge-tree observation: ${errMsg(err)}`)
      }
    }
    const statePath = conflictWatchPath(repoName)
    const state = readConflictWatch(statePath)
    const nextState: ConflictWatchState = {}
    const conflicts = prs.filter((p) => isConflicting(p, forgeConfig.repo.baseBranch))
    if (conflicts.length > 0) logEvent(`found ${conflicts.length} conflicting PR(s)`)
    const baseOid = conflicts.length > 0 ? await baseHeadOid(run, forge) : ''
    let resolvedNow = 0
    const warnings: string[] = []
    const recordPrLog = (pr: PrInfo, message: string, level: 'info' | 'error' = 'info'): void => {
      const result = `PR #${pr.number}: ${message}`
      logEvent(result, level)
      store.append(null, {
        type: 'watcher.action',
        repo,
        name: 'pr-conflict-watcher',
        runId,
        targetType: 'pr',
        targetId: String(pr.number),
        prNumber: pr.number,
        url: pr.url,
        result: message,
        level,
      })
    }
    const resolutionPrs = [...conflicts]
    for (const pr of prs) {
      if (
        queuedNow.has(stateKey(forge, pr.number)) &&
        !resolutionPrs.some((candidate) => candidate.number === pr.number)
      ) {
        resolutionPrs.push(pr)
      }
    }
    for (const pr of resolutionPrs) {
      const isConflict = conflicts.some((candidate) => candidate.number === pr.number)
      const key = stateKey(forge, pr.number)
      const manual = queuedNow.has(key)
      const headOid = pr.headRefOid ?? ''
      const seen = state[key]
      const taskId = taskIdFromPrBranch(pr.headRefName)
      const task = taskId === null ? null : store.task(taskId)
      if (isConflict && task !== null && task.prMergeStatus !== 'conflicted') {
        store.append(task.id, { type: 'pr.status', mergeStatus: 'conflicted' })
      }
      const observedTask = task === null ? null : store.task(task.id)
      if (manual && observedTask !== null) {
        if (
          observedTask.state !== 'pr_conflict_fixing' &&
          canTransition(observedTask.state, 'pr_conflict_fixing')
        ) {
          store.append(observedTask.id, {
            type: 'task.state',
            from: observedTask.state,
            to: 'pr_conflict_fixing',
            reason: `Conflict resolution running for PR #${pr.number}`,
          })
        }
      } else if (
        isConflict &&
        observedTask !== null &&
        observedTask.state !== 'pr_merge_conflict' &&
        observedTask.state !== 'pr_conflict_fixing' &&
        canTransition(observedTask.state, 'pr_merge_conflict')
      ) {
        store.append(observedTask.id, {
          type: 'task.state',
          from: observedTask.state,
          to: 'pr_merge_conflict',
          reason: `PR #${pr.number} has merge conflicts`,
        })
      }
      if (
        !manual &&
        seen !== undefined &&
        seen.headOid === headOid &&
        (seen.baseOid === baseOid || seen.contained === true)
      ) {
        nextState[key] = seen
        continue
      }
      const currentTask = task === null ? null : store.task(task.id)
      if (currentTask?.state === 'pr_merge_conflict') {
        store.append(currentTask.id, {
          type: 'task.state',
          from: currentTask.state,
          to: 'pr_conflict_fixing',
          reason: `Conflict resolution running for PR #${pr.number}`,
        })
      }
      const result: ResolveConflictResult = await resolveConflict({
        repo,
        repoRoot: root,
        repoName,
        pr,
        config: forgeConfig,
        driver: forgeDriver,
        store,
        exec,
        makeHarnessFn,
        manual,
        onLog: (level, message) => recordPrLog(pr, message, level === 'error' ? 'error' : 'info'),
        onGitBypassed: (entries) => store.append(null, { type: 'git.bypassed', entries }),
      })
      const resolvedTask = task === null ? null : store.task(task.id)
      const settledState = result.ok ? 'pr_open' : 'pr_merge_conflict'
      if (
        resolvedTask?.state === 'pr_conflict_fixing' &&
        canTransition(resolvedTask.state, settledState)
      ) {
        store.append(resolvedTask.id, {
          type: 'task.state',
          from: resolvedTask.state,
          to: settledState,
          reason: result.ok
            ? `Conflict resolution completed for PR #${pr.number}`
            : `PR #${pr.number} remains conflicted after resolution attempt`,
        })
      }
      if (isConflict) {
        nextState[key] = {
          headOid,
          baseOid,
          ...(result.verdict === undefined ? {} : { verdict: result.verdict }),
          ...(result.contained ? { contained: true } : {}),
        }
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
    // Other forges' entries are kept: their own scans own them.
    saveConflictWatch(statePath, {
      ...Object.fromEntries(Object.entries(state).filter(([key]) => !ownsKey(forge, key))),
      ...nextState,
    })
    const contained = new Map(
      conflicts
        .filter((p) => nextState[stateKey(forge, p.number)]?.contained === true)
        .map((p) => [p.number, nextState[stateKey(forge, p.number)]?.verdict ?? null]),
    )
    const pointless = await flagPointlessPrs({
      store,
      tracker,
      driver: forgeDriver,
      cwd: root,
      repoName,
      prs,
      config: forgeConfig,
      contained,
      ...(exec === undefined ? {} : { exec }),
      ...(makeHarnessFn === undefined ? {} : { makeHarnessFn }),
      onLog: (pr, level, message) => recordPrLog(pr, message, level === 'error' ? 'error' : 'info'),
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
    await syncPriorityLabels(prs, runId, forge)
    return { scanned: prs.length, conflicting: conflicts.length, resolvedNow, warnings }
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
      const queuedNow = new Set(queuedPrs)
      queuedPrs.clear()
      let scannedNow = 0
      let conflictingNow = 0
      let resolvedNow = 0
      const warnings: string[] = []
      for (const forge of forgesToScan()) {
        const result = await scanForge(forge, run, runId, queuedNow)
        scannedNow += result.scanned
        conflictingNow += result.conflicting
        resolvedNow += result.resolvedNow
        warnings.push(...result.warnings)
      }
      scanned = scannedNow
      conflicting = conflictingNow
      next.detail = `found ${conflictingNow} conflicting PRs, resolved ${resolvedNow}${
        warnings.length === 0 ? '' : `; warnings: ${warnings.join('; ')}`
      }`
      logEvent(`run ${runs} completed: scanned ${scannedNow} PRs, ${next.detail}`)
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
  }

  const poller = startPoller(intervalMs, tick, true)
  return {
    queue(prNumber, prUrl = null) {
      queuedPrs.add(stateKey(forgeFor(prUrl), prNumber))
      const runId = `queued-${Date.now()}`
      store.append(null, {
        type: 'watcher.action',
        repo,
        name: 'pr-conflict-watcher',
        runId,
        targetType: 'pr',
        targetId: String(prNumber),
        prNumber,
        result: 'conflict resolution queued',
        level: 'info',
      })
      poller.trigger()
    },
    stop() {
      poller.stop()
      activity = { ...activity, status: 'off', nextRunAt: 0 }
    },
    activity: () => activity,
  }
}
