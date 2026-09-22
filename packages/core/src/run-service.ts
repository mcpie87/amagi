import { type Config, HarnessConfig } from './config.ts'
import { claimEligible, claimGate, implementModel } from './difficulty.ts'
import type { PrDriver } from './drivers/pr.ts'
import type { Harness, Tracker, TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { makeHarness } from './factory.ts'
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

/**
 * Per-launch overrides for harness/model/effort. `harness` is a
 * harness.definitions name or a kind; model/effort override the chosen
 * harness. An omitted field falls back to config.harness.implement.
 */
export type RunOptions = {
  harness?: string
  model?: string
  effort?: string
}

/** The slice of RunService the HTTP layer depends on, so tests can stub it. */
export interface RunServiceApi {
  status(): Promise<RunnerStatus>
  start(taskId?: string, opts?: RunOptions): Promise<StartResult>
  stop(taskId: string): Promise<StopResult>
  /** Live capacity change; only affects new launches, never in-flight runs. */
  setMaxParallel(n: number): void
  /**
   * Skip the backoff of a task currently deferring an automatic retry and
   * start the next attempt immediately. 404 when the task runs elsewhere.
   */
  retryNow(taskId: string): Promise<StopResult>
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
  /**
   * Builds the harness for a launch that overrides harness/model/effort.
   * Defaults to makeHarness; tests stub it to capture the resolved config.
   */
  makeHarness?: (cfg: Config['harness']['implement']) => Harness
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
      autoQueue: this.autoQueue,
    }
  }

  start(taskId?: string, opts?: RunOptions): Promise<StartResult> {
    const result = this.launchQueue.then(() => this.tryStart(taskId, opts))
    this.launchQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Resolves the run's harness config from the launch overrides: a named
   * definition or kind wins over the configured default, then model/effort
   * override the result. `changed` is true when any override was given, so the
   * launcher can swap in a harness built for it instead of the default.
   */
  private resolveHarness(
    opts: RunOptions = {},
  ):
    | { ok: true; implement: Config['harness']['implement']; changed: boolean }
    | { ok: false; status: 409; error: string } {
    const { config } = this.opts
    let base = config.harness.implement
    if (opts.harness !== undefined) {
      const named = config.harness.definitions[opts.harness]
      if (named !== undefined) {
        base = named
      } else {
        const parsed = HarnessConfig.safeParse({ kind: opts.harness })
        if (!parsed.success) {
          return {
            ok: false,
            status: 409,
            error: `unknown harness "${opts.harness}"; use a harness.definitions name or claude/codex/opencode`,
          }
        }
        base = parsed.data
      }
    }
    if (opts.model !== undefined) base = { ...base, model: opts.model }
    if (opts.effort !== undefined) base = { ...base, effort: opts.effort }
    const changed =
      opts.harness !== undefined || opts.model !== undefined || opts.effort !== undefined
    return { ok: true, implement: base, changed }
  }

  private async tryStart(taskId?: string, opts?: RunOptions): Promise<StartResult> {
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
    const resolved = this.resolveHarness(opts)
    if (!resolved.ok) return resolved
    const { implement, changed } = resolved
    // Difficulty gating reads the model the worker would actually run, so the
    // override config (not the stored default) is what gates the claim.
    const runConfig = changed
      ? { ...this.opts.config, harness: { ...this.opts.config.harness, implement } }
      : this.opts.config
    if (taskId !== undefined) {
      const ready = await this.opts.tracker.ready()
      const target = ready.find((t) => t.id === taskId)
      if (target === undefined) {
        return { ok: false, status: 409, error: `task ${taskId} is not ready to run` }
      }
      const gate = claimGate(runConfig, target, implementModel(runConfig))
      if (!gate.allowed) {
        return { ok: false, status: 409, error: `task ${taskId}: ${gate.reason}` }
      }
      const task = await this.opts.tracker.claim(taskId)
      if (task === null) return { ok: false, status: 409, error: 'no ready task to claim' }
      this.launch(task, implement, changed)
      return { ok: true, taskId: task.id }
    }
    const skipped: string[] = []
    const task = await claimEligible(
      this.opts.tracker,
      runConfig,
      implementModel(runConfig),
      (t, reason) => skipped.push(`${t.id}: ${reason}`),
    )
    if (task === null) {
      const detail = skipped.length > 0 ? ` (skipped: ${skipped.join('; ')})` : ''
      return { ok: false, status: 409, error: `no ready task to claim${detail}` }
    }
    this.launch(task, implement, changed)
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

  async retryNow(taskId: string): Promise<StopResult> {
    const entry = this.runs.get(taskId)
    if (entry === undefined) {
      return { ok: false, status: 404, error: `task ${taskId} is not running here` }
    }
    entry.runner.retryNow()
    return { ok: true, taskId }
  }

  private launch(
    task: TrackerTask,
    implement?: Config['harness']['implement'],
    changed = false,
  ): void {
    const { store, tracker, harness, config, repoRoot, repoName, exec, forge } = this.opts
    const makeHarnessFn = this.opts.makeHarness ?? makeHarness
    const runner = new Runner({
      store,
      tracker,
      // Without overrides the runner keeps the default harness the service was
      // built with (tests inject fakes); with overrides it is built from the
      // resolved config so a picked kind/model/effort actually take effect.
      harness: changed && implement !== undefined ? makeHarnessFn(implement) : harness,
      config:
        changed && implement !== undefined
          ? { ...config, harness: { ...config.harness, implement } }
          : config,
      repoRoot,
      repoName,
      ...(exec === undefined ? {} : { exec }),
      ...(forge === undefined ? {} : { forge }),
    })
    const done = runner.runClaimed(task).finally(() => this.runs.delete(task.id))
    this.runs.set(task.id, { runner, startedAt: Date.now(), done })
  }
}
