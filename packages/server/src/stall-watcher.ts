import {
  type DoomOptions,
  type DoomSignal,
  exec as defaultExec,
  detectDoom,
  type Exec,
  errMsg,
  type ProjectedTask,
  type Store,
  type TaskState,
  type Tracker,
  type TrackerTask,
  type WorkerActivity,
} from '@amagi/core'

export type DoomGuardOptions = DoomOptions & {
  /** A live worker whose worktree diff has not changed for this long is a doom loop. */
  diffWindowMs: number
}

export type StallWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  store: Store
  tracker: Tracker
  /** Inactivity threshold: a task idle for this long gets recovered. */
  timeoutMs: number
  intervalMs?: number
  /** Doom-loop guard thresholds; omitted to disable the guard. */
  doom?: DoomGuardOptions
  exec?: Exec
}

export type StallWatcher = {
  stop(): void
  activity(): WorkerActivity
}

const DEFAULT_INTERVAL_MS = 300_000

/**
 * States where a worker/session is expected to be driving the task, so a task
 * sitting in one without a fresh heartbeat is a stalled worker. `pr_open` is
 * deliberately excluded: the PR is out for human review and no worker runs it.
 */
export const STALLED_STATES: readonly TaskState[] = [
  'claimed',
  'worktree_ready',
  'implementing',
  'awaiting_answer',
  'checks',
  'retrying',
  'committed',
]

/**
 * States where an agent is actively working, so a busy-but-not-progressing
 * worker can be spotted. `awaiting_answer` is excluded: the worker is parked
 * waiting on a human, so static tool/diff streams are expected there.
 */
export const DOOM_STATES: readonly TaskState[] = ['implementing', 'checks', 'retrying']

/** Event tail the doom guard analyzes per task each tick; covers the tool window. */
const RECENT_EVENTS_LIMIT = 2000
/** Cap on the per-tick doom scan; runs are bounded by loop.maxParallel in practice. */
const DOOM_SCAN_LIMIT = 50
const GIT_TIMEOUT_MS = 10_000

function humanMs(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/**
 * Recovers tasks whose worker stopped heartbeating: a worker process that
 * died or hung leaves its task in an in-progress state with no liveness ping
 * (the runner records one in the store every lease interval). Recovery
 * releases the tracker claim so the issue reads ready again and parks the
 * task back to `claimed`, keeping the recorded worktree for the next worker
 * to resume. Releasing the claim also makes any surviving (hung) runner
 * detect the lost lease and stop itself. A stalled task whose tracker issue
 * is already closed cannot be recovered (nothing to release, no worker will
 * ever take it), so it is parked in `needs_human` for review.
 *
 * The same tick also runs the doom-loop guard (`doom` option): a worker that
 * keeps heartbeating but never progresses (repeated identical tool calls,
 * identical check failures, or a worktree diff that never changes) gets its
 * claim released and its task parked in `needs_human` instead of being left to
 * burn budget. Unlike a stall, a doom loop is not resumed automatically, the
 * agent is stuck and a human should look.
 */
export function startStallWatcher({
  repo,
  store,
  tracker,
  timeoutMs,
  intervalMs = DEFAULT_INTERVAL_MS,
  doom,
  exec = defaultExec,
}: StallWatcherOptions): StallWatcher {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Cumulative across ticks, so the dashboard counters keep rising. */
  let recovered = 0
  let stoppedDoom = 0
  /** Tasks reconciled out of the stalled state because they could not be recovered. */
  let parked = 0
  let runs = 0
  let failures = 0
  let log: NonNullable<WorkerActivity['log']> = []
  const logEvent = (message: string, level: 'info' | 'error' = 'info'): void => {
    log = [...log, { ts: Date.now(), message, level }].slice(-100)
    activity = { ...activity, log }
  }
  const counters = (): WorkerActivity['counters'] => [
    { label: 'recovered', value: recovered },
    { label: 'doom-stopped', value: stoppedDoom },
    { label: 'parked', value: parked },
  ]
  /** Per-task diff snapshots, keyed by worktree state; pruned when a task leaves the scan. */
  const diffSince = new Map<string, { snapshot: string; since: number }>()
  let activity: WorkerActivity = {
    repo,
    name: 'stall-watcher',
    lastRunAt: 0,
    ok: true,
    error: null,
    counters: counters(),
    detail: 'no stalled tasks',
    runs: 0,
    successes: 0,
    failures: 0,
    nextRunAt: 0,
    intervalMs,
    status: 'idle',
  }

  const detail = (): string => {
    const bits: string[] = []
    if (recovered > 0) bits.push(`recovered ${recovered} stalled task${recovered === 1 ? '' : 's'}`)
    if (stoppedDoom > 0)
      bits.push(`stopped ${stoppedDoom} doom loop${stoppedDoom === 1 ? '' : 's'}`)
    if (parked > 0) bits.push(`parked ${parked} unrecoverable task${parked === 1 ? '' : 's'}`)
    return bits.length > 0 ? bits.join(', ') : 'no stalled tasks'
  }

  async function recoverDoom(task: ProjectedTask, signal: DoomSignal): Promise<void> {
    diffSince.delete(task.id)
    try {
      await tracker.release(task.id)
    } catch (err) {
      console.warn(`doom recover ${task.id}: ${errMsg(err)}`)
    }
    store.append(task.id, {
      type: 'doom.detected',
      kind: signal.kind,
      detail: signal.detail,
    })
    logEvent(`task ${task.id}: stopped doom loop (${signal.detail})`, 'error')
    store.append(task.id, {
      type: 'task.state',
      from: task.state,
      to: 'needs_human',
      reason: `recovered by doom guard: ${signal.detail}`,
    })
    console.warn(`doom loop ${task.id}: ${signal.detail}`)
  }

  /** Heuristic 3: a live worker whose worktree diff has not changed for the window. */
  async function diffStaleSignal(task: ProjectedTask, nowMs: number): Promise<DoomSignal | null> {
    if (doom === undefined || task.worktree === null) return null
    let snapshot: string
    try {
      const result = await exec(['git', 'status', '--porcelain'], {
        cwd: task.worktree,
        timeoutMs: GIT_TIMEOUT_MS,
      })
      if (result.exitCode !== 0) return null
      snapshot = result.stdout
    } catch {
      return null
    }
    const prev = diffSince.get(task.id)
    if (prev !== undefined && snapshot === prev.snapshot) {
      const staleMs = nowMs - prev.since
      if (staleMs >= doom.diffWindowMs) {
        return { kind: 'diff_static', detail: `worktree unchanged for ${humanMs(staleMs)}` }
      }
      return null
    }
    diffSince.set(task.id, { snapshot, since: nowMs })
    return null
  }

  async function doomSignalFor(task: ProjectedTask, nowMs: number): Promise<DoomSignal | null> {
    if (doom === undefined) return null
    const recent = store.recentEvents(task.id, RECENT_EVENTS_LIMIT)
    const signal = detectDoom(recent, nowMs, {
      toolWindowMs: doom.toolWindowMs,
      toolRepeat: doom.toolRepeat,
      checkRounds: doom.checkRounds,
    })
    if (signal !== null) return signal
    return diffStaleSignal(task, nowMs)
  }

  function parkClosedIssue(task: Pick<ProjectedTask, 'id' | 'state'>): void {
    const reason = 'tracker issue was closed remotely; human review needed'
    logEvent(`task ${task.id}: parked because tracker issue is closed`)
    store.append(task.id, {
      type: 'task.state',
      from: task.state,
      to: 'needs_human',
      reason,
    })
  }

  async function scanDoomLoops(nowMs: number): Promise<number> {
    if (doom === undefined) return 0
    const active = store.tasks({ states: DOOM_STATES, limit: DOOM_SCAN_LIMIT })
    const seen = new Set<string>()
    let count = 0
    for (const task of active) {
      seen.add(task.id)
      try {
        const signal = await doomSignalFor(task, nowMs)
        if (signal === null) continue
        await recoverDoom(task, signal)
        count++
      } catch (err) {
        console.warn(`doom watch ${task.id}: ${errMsg(err)}`)
      }
    }
    for (const id of [...diffSince.keys()]) {
      if (!seen.has(id)) diffSince.delete(id)
    }
    return count
  }

  async function tick(): Promise<void> {
    runs++
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
      const nowMs = Date.now()
      const found = store.stalledTasks(STALLED_STATES, nowMs - timeoutMs)
      let reclaimed = 0
      let parkedCount = 0
      for (const task of found) {
        // A tracker issue that is already closed has no claim to release and no
        // worker will ever pick it up again, so reclaiming would leave the task
        // parked back in a stalled state for the next sweep. Reconcile it out
        // of the stalled set instead and let a human settle it.
        let issue: TrackerTask | null = null
        try {
          issue = await tracker.get(task.id)
        } catch (err) {
          logEvent(`task ${task.id}: failed to read tracker issue: ${errMsg(err)}`, 'error')
          console.warn(`stall recover ${task.id}: ${errMsg(err)}`)
        }
        if (issue?.status === 'closed') {
          parkedCount++
          parkClosedIssue(task)
          continue
        }
        try {
          await tracker.release(task.id)
        } catch (err) {
          parkedCount++
          logEvent(`task ${task.id}: failed to release tracker claim: ${errMsg(err)}`, 'error')
          console.warn(`stall recover ${task.id}: ${errMsg(err)}`)
          store.append(task.id, {
            type: 'task.state',
            from: task.state,
            to: 'needs_human',
            reason: `stall recover failed: ${errMsg(err)}`,
          })
          continue
        }
        reclaimed++
        logEvent(`task ${task.id}: recovered after ${humanMs(timeoutMs)} without worker activity`)
        store.append(task.id, {
          type: 'task.reclaimed',
          reason: `recovered by stall watcher: no worker activity for ${humanMs(timeoutMs)}`,
        })
      }
      recovered += reclaimed
      parked += parkedCount

      if (tracker.reclaimExpiredClaims !== undefined) {
        try {
          await tracker.reclaimExpiredClaims()
        } catch (err) {
          const message = `tracker lease reclaim failed: ${errMsg(err)}`
          failures++
          next.ok = false
          next.error = message
          next.failures = failures
          next.successes = runs - failures
          logEvent(message, 'error')
          console.warn(`stall recover: ${message}`)
        }
      }

      let doomCount = 0
      if (doom !== undefined) {
        try {
          doomCount = await scanDoomLoops(nowMs)
        } catch (err) {
          logEvent(`doom loop scan failed: ${errMsg(err)}`, 'error')
          console.warn(`doom watch: ${errMsg(err)}`)
        }
      }
      stoppedDoom += doomCount

      next.counters = counters()
      next.detail = detail()
      logEvent(`run ${runs} completed: ${next.detail}`)
    } catch (err) {
      failures++
      next.ok = false
      next.error = errMsg(err)
      next.failures = failures
      next.successes = runs - failures
      logEvent(`run ${runs} failed: ${next.error}`, 'error')
      console.warn(`stall watch: ${next.error}`)
    }
    next.log = log
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
