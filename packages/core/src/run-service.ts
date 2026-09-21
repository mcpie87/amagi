import type { Config } from './config.ts'
import { claimEligible, claimGate, implementModel } from './difficulty.ts'
import type { PrDriver } from './drivers/pr.ts'
import type { Harness, Tracker, TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { processTreeStats } from './process.ts'
import { Runner, type RunOnceResult } from './runner.ts'
import type { Store } from './store/store.ts'

/** Summed over the agent's whole process tree (see process.ts). */
export type RunnerResource = {
  processes: number
  rssBytes: number
  cpuMs: number
}

/** A running task's identity, so the dashboard can show it from the polled
 *  channel like rss/cpu instead of relying on the SSE projection. */
export type RunnerTask = {
  title: string
  /** The configured implement harness for the run. */
  harness: string
  model: string | null
  effort: string | null
}

export type RunnerStatus = {
  /** Repo name the runner is bound to, so several runners can be told apart. */
  name: string
  available: boolean
  capacity: number
  running: string[]
  /** Epoch ms at launch per running task, keyed by task id, for live elapsed-time display. */
  startedAt: Record<string, number>
  /** Resource usage per running task, keyed by task id; absent when no agent is live. */
  resources: Record<string, RunnerResource>
  /** Title and live agent per running task, keyed by task id. */
  tasks: Record<string, RunnerTask>
  /** Whether automatic dispatch is on: ready tasks launch themselves on free slots. */
  autoQueue: boolean
  /** Activity of background workers (e.g. the mention watcher), when any. */
  workers?: WorkerActivity[]
}

/** One background worker's latest tick, surfaced in the dashboard Workers section. */
export type WorkerActivity = {
  /** Repo key the worker is bound to. */
  repo: string
  name: string
  /** Epoch ms of the last completed tick; 0 before the first tick. */
  lastRunAt: number
  ok: boolean
  error: string | null
  /** Counters reported by the worker, rendered as label/value pairs in the dashboard. */
  counters: WorkerCounter[]
  /** Human summary of the last tick for workers without counters. */
  detail?: string | null
}

/** One named counter a worker reports (e.g. scanned, responded, resolved). */
export type WorkerCounter = { label: string; value: number }

export type StartResult = { ok: true; taskId: string } | { ok: false; status: 409; error: string }
export type StopResult = { ok: true; taskId: string } | { ok: false; status: 404; error: string }

/** The slice of RunService the HTTP layer depends on, so tests can stub it. */
export interface RunServiceApi {
  status(): Promise<RunnerStatus>
  start(taskId?: string): Promise<StartResult>
  stop(taskId: string): Promise<StopResult>
  /** Live capacity change; only affects new launches, never in-flight runs. */
  setMaxParallel(n: number): void
  /** Live automatic-dispatch toggle; a fresh launch loop starts or stops. */
  setAutoQueue(enabled: boolean): void
  /** Stops the automatic-dispatch loop, for server shutdown. */
  dispose?(): void
}

export type RunServiceOptions = {
  store: Store
  tracker: Tracker
  harness: Harness
  config: Config
  repoRoot: string
  repoName: string
  exec?: Exec
  forge?: PrDriver
  /** Overrides config.loop.maxParallel, mainly for tests. */
  maxParallel?: number
  /** Overrides config.loop.autoQueue, mainly for tests. */
  autoQueue?: boolean
  /** Overrides config.loop.autoQueueIdleSec, mainly for tests. */
  autoQueueIdleMs?: number
  /** How often to poll while a launch just succeeded (filling free slots). */
  autoQueueActiveMs?: number
}

/**
 * Long-lived runner behind `amagi serve`: owns the in-flight runs, so it can
 * answer launch/stop requests and report capacity. Claims happen here (not in
 * the Runner) so a launch answers with the exact task id and readiness is
 * checked against the tracker before taking the task.
 */
export class RunService implements RunServiceApi {
  private capacity: number
  private readonly runs = new Map<
    string,
    { runner: Runner; startedAt: number; done: Promise<RunOnceResult> }
  >()
  /** Serializes launches so two concurrent requests cannot claim the same task. */
  private launchQueue: Promise<void> = Promise.resolve()
  private autoQueue: boolean
  private readonly autoQueueIdleMs: number
  /** While work is flowing (a launch just happened) poll quickly to fill free slots. */
  private readonly autoQueueActiveMs: number
  private autoQueueTimer: ReturnType<typeof setTimeout> | null = null
  private autoQueuePolling = false
  private stopped = false

  constructor(private readonly opts: RunServiceOptions) {
    this.capacity = opts.maxParallel ?? opts.config.loop.maxParallel
    this.autoQueue = opts.autoQueue ?? opts.config.loop.autoQueue
    this.autoQueueIdleMs = opts.autoQueueIdleMs ?? opts.config.loop.autoQueueIdleSec * 1000
    this.autoQueueActiveMs = opts.autoQueueActiveMs ?? 5_000
    if (this.autoQueue) this.scheduleAutoQueuePoll(0)
  }

  /**
   * Live capacity change: `status()` and new launches read the new value, runs
   * already in flight are untouched. The floor keeps a buggy caller from
   * zeroing out the runner; the upper bound is enforced at the config/API layer.
   */
  setMaxParallel(n: number): void {
    this.capacity = Math.max(1, n)
  }

  /**
   * Live automatic-dispatch toggle. Turning it on starts the poll loop (a poll
   * is scheduled immediately, not after the first idle wait); turning it off
   * cancels the pending poll. In-flight runs are untouched either way.
   */
  setAutoQueue(enabled: boolean): void {
    this.autoQueue = enabled
    if (enabled) {
      this.scheduleAutoQueuePoll(0)
    } else if (this.autoQueueTimer !== null) {
      clearTimeout(this.autoQueueTimer)
      this.autoQueueTimer = null
    }
  }

  /** Stops the auto-queue loop; the runner stays usable for manual launch/stop. */
  dispose(): void {
    this.stopped = true
    if (this.autoQueueTimer !== null) {
      clearTimeout(this.autoQueueTimer)
      this.autoQueueTimer = null
    }
  }

  private scheduleAutoQueuePoll(ms: number): void {
    if (this.stopped) return
    if (this.autoQueueTimer !== null) clearTimeout(this.autoQueueTimer)
    this.autoQueueTimer = setTimeout(() => void this.autoQueuePoll(), ms)
  }

  /**
   * One auto-queue pass: claim and launch the next ready task when a slot is
   * free. A claimed task means more free slots may exist, so the next poll is
   * soon; an empty (or gated, or at-capacity) queue means nothing to do, so
   * the poll backs off to the idle interval.
   */
  private async autoQueuePoll(): Promise<void> {
    if (this.autoQueuePolling) return
    this.autoQueuePolling = true
    try {
      if (!this.autoQueue || this.stopped) return
      const result = await this.start()
      const backoff = result.ok ? this.autoQueueActiveMs : this.autoQueueIdleMs
      if (this.autoQueue && !this.stopped) this.scheduleAutoQueuePoll(backoff)
    } finally {
      this.autoQueuePolling = false
    }
  }

  async status(): Promise<RunnerStatus> {
    const running = [...this.runs.keys()]
    const startedAt: Record<string, number> = {}
    const resources: Record<string, RunnerResource> = {}
    const tasks: Record<string, RunnerTask> = {}
    await Promise.all(
      running.map(async (id) => {
        const pid = this.runs.get(id)?.runner.currentPid()
        if (pid !== null && pid !== undefined && pid > 0) {
          resources[id] = await processTreeStats(pid)
        }
        const task = this.opts.store.task(id)
        const agent = this.opts.store.currentAgent(id)
        tasks[id] = {
          title: task?.title ?? id,
          // The configured harness is known at launch; only the model/effort
          // wait for the agent run to report them.
          harness: this.opts.harness.kind,
          model: agent?.model ?? null,
          effort: agent?.effort ?? null,
        }
      }),
    )
    for (const [id, entry] of this.runs) startedAt[id] = entry.startedAt
    return {
      name: this.opts.repoName,
      available: running.length < this.capacity,
      capacity: this.capacity,
      running,
      startedAt,
      resources,
      tasks,
      autoQueue: this.autoQueue,
    }
  }

  start(taskId?: string): Promise<StartResult> {
    const result = this.launchQueue.then(() => this.tryStart(taskId))
    this.launchQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async tryStart(taskId?: string): Promise<StartResult> {
    if (taskId !== undefined && this.runs.has(taskId)) {
      return { ok: false, status: 409, error: `task ${taskId} is already running` }
    }
    if (this.runs.size >= this.capacity) {
      return {
        ok: false,
        status: 409,
        error: `runner at capacity (${this.runs.size}/${this.capacity})`,
      }
    }
    if (taskId !== undefined) {
      const ready = await this.opts.tracker.ready()
      const target = ready.find((t) => t.id === taskId)
      if (target === undefined) {
        return { ok: false, status: 409, error: `task ${taskId} is not ready to run` }
      }
      const gate = claimGate(this.opts.config, target, implementModel(this.opts.config))
      if (!gate.allowed) {
        return { ok: false, status: 409, error: `task ${taskId}: ${gate.reason}` }
      }
      const task = await this.opts.tracker.claim(taskId)
      if (task === null) return { ok: false, status: 409, error: 'no ready task to claim' }
      this.launch(task)
      return { ok: true, taskId: task.id }
    }
    const skipped: string[] = []
    const task = await claimEligible(
      this.opts.tracker,
      this.opts.config,
      implementModel(this.opts.config),
      (t, reason) => skipped.push(`${t.id}: ${reason}`),
    )
    if (task === null) {
      const detail = skipped.length > 0 ? ` (skipped: ${skipped.join('; ')})` : ''
      return { ok: false, status: 409, error: `no ready task to claim${detail}` }
    }
    this.launch(task)
    return { ok: true, taskId: task.id }
  }

  async stop(taskId: string): Promise<StopResult> {
    const entry = this.runs.get(taskId)
    if (entry === undefined) {
      return { ok: false, status: 404, error: `task ${taskId} is not running here` }
    }
    entry.runner.cancel()
    await entry.done
    return { ok: true, taskId }
  }

  private launch(task: TrackerTask): void {
    const { store, tracker, harness, config, repoRoot, repoName, exec, forge } = this.opts
    const runner = new Runner({
      store,
      tracker,
      harness,
      config,
      repoRoot,
      repoName,
      ...(exec === undefined ? {} : { exec }),
      ...(forge === undefined ? {} : { forge }),
    })
    const done = runner.runClaimed(task).finally(() => this.runs.delete(task.id))
    this.runs.set(task.id, { runner, startedAt: Date.now(), done })
  }
}
