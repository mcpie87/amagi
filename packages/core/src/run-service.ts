import type { Config } from './config.ts'
import type { PrDriver } from './drivers/pr.ts'
import type { Harness, Tracker, TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { Runner, type RunOnceResult } from './runner.ts'
import type { Store } from './store/store.ts'

export type RunnerStatus = {
  available: boolean
  capacity: number
  running: string[]
}

export type StartResult = { ok: true; taskId: string } | { ok: false; status: 409; error: string }
export type StopResult = { ok: true; taskId: string } | { ok: false; status: 404; error: string }

/** The slice of RunService the HTTP layer depends on, so tests can stub it. */
export interface RunServiceApi {
  status(): RunnerStatus
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
}

/**
 * Long-lived runner behind `amagi serve`: owns the in-flight runs, so it can
 * answer launch/stop requests and report capacity. Claims happen here (not in
 * the Runner) so a launch answers with the exact task id and readiness is
 * checked against the tracker before taking the task.
 */
export class RunService implements RunServiceApi {
  private capacity: number
  private readonly runs = new Map<string, { runner: Runner; done: Promise<RunOnceResult> }>()
  /** Serializes launches so two concurrent requests cannot claim the same task. */
  private launchQueue: Promise<void> = Promise.resolve()

  constructor(private readonly opts: RunServiceOptions) {
    this.capacity = opts.maxParallel ?? opts.config.loop.maxParallel
  }

  /**
   * Live capacity change: `status()` and new launches read the new value, runs
   * already in flight are untouched. The floor keeps a buggy caller from
   * zeroing out the runner; the upper bound is enforced at the config/API layer.
   */
  setMaxParallel(n: number): void {
    this.capacity = Math.max(1, n)
  }

  status(): RunnerStatus {
    const running = [...this.runs.keys()]
    return {
      available: running.length < this.capacity,
      capacity: this.capacity,
      running,
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
      if (!ready.some((t) => t.id === taskId)) {
        return { ok: false, status: 409, error: `task ${taskId} is not ready to run` }
      }
    }
    const task = await this.opts.tracker.claim(taskId)
    if (task === null) return { ok: false, status: 409, error: 'no ready task to claim' }
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
    this.runs.set(task.id, { runner, done })
  }
}
