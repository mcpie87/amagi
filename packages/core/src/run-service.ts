import { type Config, HarnessConfig, type WorkerConfig } from './config.ts'
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

/** A running task's identity, so the dashboard can show it from the polled
 *  channel like rss/cpu instead of relying on the SSE projection. */
export type RunnerTask = {
  title: string
  workerId?: string | null
  workerName?: string | null
  seat?: string
  /** True until a harness emits agent.started after blocking on its seat. */
  waitingOnSeat?: boolean
  /** True for a foreground run that does not match a configured worker. */
  adHoc?: boolean
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
  fleet?: FleetWorkerStatus[]
  /** Activity of background workers (e.g. the mention watcher), when any. */
  workers?: WorkerActivity[]
}

export type FleetWorkerStatus = {
  id: string
  name: string
  kind: WorkerConfig['kind']
  model: string | null
  effort: string | null
  seat: string
  enabled: boolean
  on: boolean
  busy: boolean
  /** The task this worker itself is running, as opposed to another worker on its seat. */
  taskId: string | null
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
  /** Recent run and event messages, newest entries last. */
  log?: WorkerLogEntry[]
}

export type WorkerLogEntry = {
  ts: number
  message: string
  level: 'info' | 'error'
}

/** One named counter a worker reports (e.g. scanned, responded, resolved). */
export type WorkerCounter = { label: string; value: number }

export type StartResult = { ok: true; taskId: string } | { ok: false; status: 409; error: string }
export type StopResult = { ok: true; taskId: string } | { ok: false; status: 404; error: string }

/**
 * Manual dispatch targets a named worker; model and effort may override its profile.
 */
export type RunOptions = {
  workerId?: string
  model?: string
  effort?: string
}

/** The slice of RunService the HTTP layer depends on, so tests can stub it. */
export interface RunServiceApi {
  status(): Promise<RunnerStatus>
  start(taskId?: string, opts?: RunOptions): Promise<StartResult>
  stop(taskId: string): Promise<StopResult>
  setWorkerOn(workerId: string, on: boolean): void
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
  exec?: Exec | undefined
  forge?: PrDriver | undefined
  /**
   * Builds the harness for a launch that overrides harness/model/effort.
   * Defaults to makeHarness; tests stub it to capture the resolved config.
   */
  makeHarness?: (cfg: Config['harness']['implement']) => Harness
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
  private readonly runs = new Map<
    string,
    {
      runner: Runner
      startedAt: number
      done: Promise<RunOnceResult>
      workerId: string
      seat: string
    }
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
  private readonly workerOn = new Map<string, boolean>()

  constructor(private readonly opts: RunServiceOptions) {
    for (const worker of opts.config.worker) this.workerOn.set(worker.id, false)
    this.autoQueue = opts.autoQueue ?? opts.config.loop.autoQueue
    this.autoQueueIdleMs = opts.autoQueueIdleMs ?? opts.config.loop.autoQueueIdleSec * 1000
    this.autoQueueActiveMs = opts.autoQueueActiveMs ?? 5_000
    if (this.autoQueue) this.scheduleAutoQueuePoll(0)
  }

  setWorkerOn(workerId: string, on: boolean): void {
    if (this.opts.config.worker.some((worker) => worker.id === workerId && worker.enabled)) {
      this.workerOn.set(workerId, on)
      if (on && this.autoQueue) this.scheduleAutoQueuePoll(0)
    }
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
      const result = await this.start(undefined, undefined, true)
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
        const entry = this.runs.get(id)
        const pid = entry?.runner.currentPid()
        if (pid !== null && pid !== undefined && pid > 0) {
          resources[id] = await processTreeStats(pid)
        }
        const task = this.opts.store.task(id)
        const agent = this.opts.store.currentAgent(id)
        const worker = this.opts.config.worker.find((candidate) => candidate.id === entry?.workerId)
        const latestEvents = this.opts.store.recentEvents(id, 100)
        const waitingSeatEvent = [...latestEvents]
          .reverse()
          .find(
            (event) =>
              event.type === 'agent.stream' &&
              event.event.kind === 'status' &&
              event.event.message.startsWith('waiting for seat '),
          )
        const latestAgentStart = [...latestEvents]
          .reverse()
          .find((event) => event.type === 'agent.started')
        const waitingOnSeat =
          waitingSeatEvent !== undefined &&
          (latestAgentStart === undefined || waitingSeatEvent.seq > latestAgentStart.seq)
        tasks[id] = {
          title: task?.title ?? id,
          workerId: worker?.id ?? null,
          workerName: worker?.name ?? null,
          seat: entry?.seat ?? worker?.seat ?? worker?.kind ?? this.opts.harness.kind,
          waitingOnSeat,
          // The configured harness is known at launch; only the model/effort
          // wait for the agent run to report them.
          harness:
            this.opts.config.worker.find((worker) => worker.id === entry?.workerId)?.kind ??
            this.opts.harness.kind,
          model: agent?.model ?? null,
          effort: agent?.effort ?? null,
        }
      }),
    )
    for (const [id, entry] of this.runs) startedAt[id] = entry.startedAt
    return {
      name: this.opts.repoName,
      available: this.availableCapacity(true) > 0,
      capacity: this.availableCapacity(true),
      running,
      startedAt,
      resources,
      tasks,
      autoQueue: this.autoQueue,
      fleet: this.opts.config.worker.map((worker) => ({
        id: worker.id,
        name: worker.name,
        kind: worker.kind,
        model: worker.model ?? null,
        effort: worker.effort ?? null,
        seat: this.workerSeat(worker),
        enabled: worker.enabled,
        on: this.workerOn.get(worker.id) === true,
        busy: this.runsBySeat().has(this.workerSeat(worker)),
        taskId: [...this.runs].find(([, run]) => run.workerId === worker.id)?.[0] ?? null,
      })),
    }
  }

  start(taskId?: string, opts?: RunOptions, automatic = false): Promise<StartResult> {
    const result = this.launchQueue.then(() => this.tryStart(taskId, opts, automatic))
    this.launchQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Resolves the selected worker profile into the harness config for a run. */
  private resolveHarness(
    worker: WorkerConfig,
    opts: RunOptions = {},
  ): Config['harness']['implement'] {
    const { config } = this.opts
    const base =
      worker.kind === config.harness.implement.kind
        ? config.harness.implement
        : HarnessConfig.parse({ kind: worker.kind })
    return {
      ...base,
      model: opts.model ?? worker.model ?? base.model,
      effort: opts.effort ?? worker.effort ?? base.effort,
      seat: worker.seat ?? worker.kind,
    }
  }

  private workerSeat(worker: WorkerConfig): string {
    return worker.seat ?? worker.kind
  }

  private runsBySeat(): Map<string, string> {
    return new Map([...this.runs].map(([id, run]) => [run.seat, id]))
  }

  private availableWorkers(automatic: boolean): WorkerConfig[] {
    const busy = this.runsBySeat()
    return this.opts.config.worker.filter(
      (worker) =>
        worker.enabled &&
        (!automatic || this.workerOn.get(worker.id) === true) &&
        !busy.has(this.workerSeat(worker)),
    )
  }

  private availableCapacity(automatic: boolean): number {
    return new Set(this.availableWorkers(automatic).map((worker) => this.workerSeat(worker))).size
  }

  private async tryStart(
    taskId?: string,
    opts?: RunOptions,
    automatic = false,
  ): Promise<StartResult> {
    if (taskId !== undefined && this.runs.has(taskId)) {
      return { ok: false, status: 409, error: `task ${taskId} is already running` }
    }
    const selected =
      opts?.workerId === undefined
        ? this.availableWorkers(automatic)[0]
        : this.opts.config.worker.find((worker) => worker.id === opts.workerId)
    if (selected === undefined) return { ok: false, status: 409, error: 'no available worker' }
    if (!selected.enabled)
      return { ok: false, status: 409, error: `worker ${selected.id} is disabled` }
    if (automatic && this.workerOn.get(selected.id) !== true) {
      return { ok: false, status: 409, error: `worker ${selected.id} is off` }
    }
    if (this.runsBySeat().has(this.workerSeat(selected))) {
      return { ok: false, status: 409, error: `worker ${selected.id} seat is busy` }
    }
    const implement = this.resolveHarness(selected, opts)
    // Difficulty gating reads the model the worker would actually run, so the
    // override config (not the stored default) is what gates the claim.
    const runConfig = { ...this.opts.config, harness: { ...this.opts.config.harness, implement } }
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
      this.launch(task, selected, implement)
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
    this.launch(task, selected, implement)
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
    worker: WorkerConfig,
    implement: Config['harness']['implement'],
  ): void {
    const { store, tracker, config, repoRoot, repoName, exec, forge } = this.opts
    const makeHarnessFn = this.opts.makeHarness ?? makeHarness
    const harness =
      makeHarnessFn === makeHarness && implement.kind === config.harness.implement.kind
        ? this.opts.harness
        : makeHarnessFn(implement)
    const runner = new Runner({
      store,
      tracker,
      harness,
      config: { ...config, harness: { ...config.harness, implement } },
      repoRoot,
      repoName,
      // A server-side run has the ask and git-request channels to POST to.
      channel: true,
      exec,
      forge,
    })
    const seat = this.workerSeat(worker)
    const done = runner.runClaimed(task).finally(() => this.runs.delete(task.id))
    this.runs.set(task.id, { runner, startedAt: Date.now(), done, workerId: worker.id, seat })
  }
}
