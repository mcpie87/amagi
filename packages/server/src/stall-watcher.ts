import type { Store, TaskState, Tracker, WorkerActivity } from '@amagi/core'

export type StallWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  store: Store
  tracker: Tracker
  /** Inactivity threshold: a task idle for this long gets recovered. */
  timeoutMs: number
  intervalMs?: number
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
  'reviewing',
  'fixing',
]

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function humanMs(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

/**
 * Recovers tasks whose worker stopped heartbeating: a worker process that
 * died or hung leaves its task in an in-progress state with no liveness ping
 * (the runner records one in the store every lease interval). Recovery
 * releases the tracker claim so the issue reads ready again and parks the
 * task back to `claimed`, keeping the recorded worktree for the next worker
 * to resume. Releasing the claim also makes any surviving (hung) runner
 * detect the lost lease and stop itself.
 */
export function startStallWatcher({
  repo,
  store,
  tracker,
  timeoutMs,
  intervalMs = DEFAULT_INTERVAL_MS,
}: StallWatcherOptions): StallWatcher {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Cumulative across ticks, like the mention watcher's counters. */
  let recovered = 0
  let activity: WorkerActivity = {
    repo,
    name: 'stall-watcher',
    lastRunAt: 0,
    ok: true,
    error: null,
    prsScanned: 0,
    mentionsResponded: 0,
    detail: 'no stalled tasks',
  }

  async function tick(): Promise<void> {
    const next: WorkerActivity = { ...activity, lastRunAt: Date.now(), ok: true, error: null }
    try {
      const found = store.stalledTasks(STALLED_STATES, Date.now() - timeoutMs)
      for (const task of found) {
        try {
          await tracker.release(task.id)
        } catch (err) {
          console.warn(`stall recover ${task.id}: ${errMsg(err)}`)
        }
        store.append(task.id, {
          type: 'task.reclaimed',
          reason: `recovered by stall watcher: no worker activity for ${humanMs(timeoutMs)}`,
        })
      }
      recovered += found.length
      next.detail =
        recovered > 0
          ? `recovered ${recovered} stalled task${recovered === 1 ? '' : 's'}`
          : 'no stalled tasks'
    } catch (err) {
      next.ok = false
      next.error = errMsg(err)
      console.warn(`stall watch: ${next.error}`)
    }
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
