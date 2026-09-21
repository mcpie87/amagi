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
  /** Activity of background workers (e.g. the mention watcher), when any. */
  workers?: WorkerActivity[]
}

/** Lifecycle of a background worker: active = ticking, idle = waiting on the first tick, off = stopped. */
export type WorkerStatus = 'active' | 'idle' | 'off'

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
  /** Human summary of the last tick: phase, what was scanned and dispatched/found. */
  detail?: string | null
  /** Cumulative completed ticks since the watcher started. */
  runs: number
  /** Completed ticks that ended ok. */
  successes: number
  /** Completed ticks that failed. */
  failures: number
  /** Epoch ms of the next scheduled tick; 0 when the watcher is stopped. */
  nextRunAt: number
  /** Tick cadence in ms. */
  intervalMs: number
  status: WorkerStatus
}

/** One named counter a worker reports (e.g. scanned, responded, resolved). */
export type WorkerCounter = { label: string; value: number }

export type StartResult = { ok: true; taskId: string } | { ok: false; status: 409; error: string }
export type StopResult = { ok: true; taskId: string } | { ok: false; status: 404; error: string }

/** How often the auto-pick loop re-checks for ready work. */
const AUTO_PICK_POLL_MS = 3000

/** The slice of RunService the HTTP layer depends on, so tests can stub it. */
export interface RunServiceApi {
  status(): Promise<RunnerStatus>
  start(taskId?: string): Promise<StartResult>
  stop(taskId: string): Promise<StopResult>
  /** Live capacity change; only affects new launches, never in-flight runs. */
  setMaxParallel(n: number): void
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
  /**
   * When true (default), the service fills every free runner slot with the
   * next ready task on its own, so nothing waits for a manual run click.
   */
  autoPick?: boolean
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
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: RunServiceOptions) {
    this.capacity = opts.maxParallel ?? opts.config.loop.maxParallel
    if (opts.autoPick ?? true) void this.pickLoop()
  }

  /**
   * Live capacity change: `status()` and new launches read the new value, runs
   * already in flight are untouched. The floor keeps a buggy caller from
   * zeroing out the runner; the upper bound is enforced at the config/API layer.
   */
  setMaxParallel(n: number): void {
    this.capacity = Math.max(1, n)
  }

  async status(): Promise<RunnerStatus> {
    const running = [...this.runs.keys()]
    const startedAt: Record<string, number> = {}
    const resources: Record<string, RunnerResource> = {}
    await Promise.all(
      running.map(async (id) => {
        const pid = this.runs.get(id)?.runner.currentPid()
        if (pid === null || pid === undefined || pid <= 0) return
        resources[id] = await processTreeStats(pid)
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
    }
  }

  /** Stops the server-driven pick loop; in-flight runs keep going. */
  close(): void {
    this.stopped = true
    if (this.pollTimer !== null) clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /**
   * Server-driven picking: keeps every free runner slot filled with the next
   * ready task (FCFS via the tracker) so a run never waits for a click. Polls
   * so freshly created tasks and freed slots are both picked up; launches go
   * through the same launchQueue as manual starts, so no double-claim.
   */
  private async pickLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.fillSlots()
      } catch (err) {
        console.warn(`auto-pick: ${err instanceof Error ? err.message : String(err)}`)
      }
      await new Promise((resolve) => {
        this.pollTimer = setTimeout(resolve, AUTO_PICK_POLL_MS)
      })
    }
  }

  private async fillSlots(): Promise<void> {
    while (this.runs.size < this.capacity) {
      const result = await this.start()
      if (!result.ok) return
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
