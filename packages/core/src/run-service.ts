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
  /** Resource usage per running task, keyed by task id; absent when no agent is live. */
  resources: Record<string, RunnerResource>
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
  prsScanned: number
  mentionsResponded: number
  /** Human summary of the last tick for workers without PR/mention counters. */
  detail?: string | null
}

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

  async status(): Promise<RunnerStatus> {
    const running = [...this.runs.keys()]
    const resources: Record<string, RunnerResource> = {}
    await Promise.all(
      running.map(async (id) => {
        const pid = this.runs.get(id)?.runner.currentPid()
        if (pid === null || pid === undefined || pid <= 0) return
        resources[id] = await processTreeStats(pid)
      }),
    )
    return {
      name: this.opts.repoName,
      available: running.length < this.capacity,
      capacity: this.capacity,
      running,
      resources,
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
    this.runs.set(task.id, { runner, done })
  }
}
