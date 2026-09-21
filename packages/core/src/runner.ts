import type { Config } from './config.ts'
import { claimEligible, implementModel } from './difficulty.ts'
import { forgeToken, gitTokenConfig } from './drivers/forge-cred.ts'
import { amagiLabels, type CreatePrOptions, makePrDriver, type PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Harness, Tracker, TrackerTask } from './drivers/types.ts'
import { type CheckResult, isTerminal, type TaskState } from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts } from './factory.ts'
import { changesSinceBase, formatPrBody } from './pr-body.ts'
import {
  answerPrompt,
  commitMessage,
  fixChecksPrompt,
  implementPrompt,
  implementSystemPrompt,
  prTitle,
  reclaimPrompt,
  whyNoChangesPrompt,
} from './prompt.ts'
import { backoffDelayMs, isTransientFailure } from './retry.ts'
import type { Store, TaskRow } from './store/store.ts'
import { createWorktree, type WorktreeSpec } from './worktree.ts'

export type RunnerDeps = {
  store: Store
  tracker: Tracker
  harness: Harness
  config: Config
  repoRoot: string
  repoName: string
  exec?: Exec
  /** Overridable so tests do not need gh installed. Defaults to the configured forge driver. */
  forge?: PrDriver
}

export type RunOnceResult = {
  task: TaskRow
  state: TaskState
} | null

/** How often the parked runner re-checks the store for an answer. */
const PARK_POLL_MS = 100

/**
 * Worker heartbeat cadence into the store, well under the default 1h stall
 * threshold so a live runner never looks stalled. Kept separate from the
 * tracker lease cadence: forge/github grant a 6h lease, which would make the
 * lease tick far too slow to serve as the stall watcher's activity signal.
 */
const WORKER_HEARTBEAT_MS = 60_000

class LeaseLostError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId}: claim lease was reclaimed, stopping before another worker collides`)
    this.name = 'LeaseLostError'
  }
}

/** Thrown inside the drive loop once the operator asks for a stop. */
export class RunCancelledError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId}: run cancelled by operator`)
    this.name = 'RunCancelledError'
  }
}

/**
 * Keeps the tracker claim alive for as long as the task is in flight. bd hands
 * out a short lease and reverts the issue to ready once it lapses, so a long
 * agent run without this silently loses the task to `bd reclaim`.
 */
class Lease {
  private timer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lost = false

  constructor(
    private readonly tracker: Tracker,
    private readonly store: Store,
    private readonly taskId: string,
  ) {}

  start(): void {
    const period = Math.max(30_000, Math.floor(this.tracker.leaseTtlMs / 3))
    this.timer = setInterval(() => {
      void this.tracker.heartbeat(this.taskId).then((alive) => {
        if (!alive) this.lost = true
      })
    }, period)
    this.heartbeatTimer = setInterval(() => {
      this.store.heartbeat(this.taskId)
    }, WORKER_HEARTBEAT_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  get isLost(): boolean {
    return this.lost
  }
}

export class Runner {
  private readonly exec: Exec
  private cancelled = false
  private currentProcess: AgentProcess | null = null

  constructor(private readonly deps: RunnerDeps) {
    this.exec = deps.exec ?? defaultExec
  }

  /**
   * Ask the run to stop: kill the owned agent process and unwind through the
   * next phase boundary into the cancelled state, keeping the worktree.
   */
  cancel(): void {
    this.cancelled = true
    if (this.currentProcess !== null) void this.currentProcess.kill()
  }

  /** The pid of the live agent process, or null between agent phases. */
  currentPid(): number | null {
    return this.currentProcess?.pid ?? null
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelled) throw new RunCancelledError(taskId)
  }

  /** Claims one ready task and drives it as far as the current milestone goes. */
  async runOnce(): Promise<RunOnceResult> {
    const { store, tracker, config } = this.deps
    const task = await claimEligible(tracker, config, implementModel(config), (skipped, reason) => {
      store.append(null, {
        type: 'claim.rejected',
        title: skipped.title,
        difficulty: skipped.difficulty ?? null,
        reason,
      })
    })
    if (task === null) return null
    return this.runClaimed(task)
  }

  /**
   * Drives a task the caller already claimed (the runner service claims first
   * so it can answer a launch request with the exact task id).
   */
  async runClaimed(task: TrackerTask): Promise<RunOnceResult> {
    const { store } = this.deps
    store.append(task.id, {
      type: 'task.claimed',
      title: task.title,
      tracker: this.deps.tracker.kind,
      description: task.description,
      priority: task.priority,
      taskType: task.type,
      url: task.url,
      ...(task.difficulty === undefined || task.difficulty === null
        ? {}
        : { difficulty: task.difficulty }),
    })

    try {
      await this.drive(task)
    } catch (err) {
      if (err instanceof RunCancelledError) {
        await this.finishCancelled(task.id)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        store.append(task.id, { type: 'error', message, fatal: true })
        this.transition(task.id, 'needs_human', message)
      }
    }

    const row = store.task(task.id)
    if (row === null) throw new Error(`task ${task.id} vanished from the store mid-run`)
    return { task: row, state: row.state }
  }

  /**
   * Graceful stop tail: park the task in the explicit cancelled terminal state
   * and hand the tracker lease back, but leave the recorded worktree and
   * branch untouched so the existing reclaim path can resume the work later.
   */
  private async finishCancelled(taskId: string): Promise<void> {
    const { store, tracker } = this.deps
    const current = store.task(taskId)
    if (current !== null && !isTerminal(current.state)) {
      store.append(taskId, {
        type: 'task.state',
        from: current.state,
        to: 'cancelled',
        reason: 'operator stopped the run',
      })
    }
    try {
      await tracker.release(taskId)
    } catch (err) {
      console.warn(`release ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private transition(taskId: string, to: TaskState, reason?: string): void {
    const from = this.deps.store.task(taskId)?.state ?? null
    if (from === to) return
    this.deps.store.append(taskId, {
      type: 'task.state',
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  private async drive(task: TrackerTask): Promise<void> {
    const { store, config } = this.deps

    // A reclaimed task already has its worktree and branch recorded in the
    // store; reuse them instead of creating a fresh worktree.
    const recorded = store.task(task.id)
    const resume = recorded !== null && recorded.worktree !== null && recorded.branch !== null

    let worktree: WorktreeSpec
    if (resume) {
      worktree = {
        path: recorded.worktree as string,
        branch: recorded.branch as string,
      }
    } else {
      // With a token present, base the worktree on a fresh origin fetch over
      // https; without one, fall back to the local base branch so git never
      // prompts during an unattended run.
      const tokenCfg = await gitTokenConfig(
        this.exec,
        this.deps.repoRoot,
        config.forge.remote,
        forgeToken(config.forge.kind),
      )
      if (tokenCfg.length > 0) {
        await execOk(this.exec, ['git', ...tokenCfg, 'fetch', 'origin', config.repo.baseBranch], {
          cwd: this.deps.repoRoot,
        })
      }
      const base = tokenCfg.length > 0 ? `origin/${config.repo.baseBranch}` : config.repo.baseBranch
      worktree = await createWorktree({
        repoRoot: this.deps.repoRoot,
        repoName: this.deps.repoName,
        taskId: task.id,
        title: task.title,
        baseBranch: base,
        worktreeRoot: config.repo.worktreeRoot,
        setupCmd: config.repo.setupCmd,
        persona: config.repo.persona,
        exec: this.exec,
      })
    }
    store.append(task.id, {
      type: 'worktree.created',
      path: worktree.path,
      branch: worktree.branch,
    })
    this.transition(task.id, 'worktree_ready')
    this.throwIfCancelled(task.id)

    const lease = new Lease(this.deps.tracker, this.deps.store, task.id)
    lease.start()
    try {
      await this.implementAndCheck(task, worktree.path, worktree.branch, lease, resume)
    } finally {
      lease.stop()
    }
  }

  private async implementAndCheck(
    task: TrackerTask,
    cwd: string,
    branch: string,
    lease: Lease,
    resume = false,
  ): Promise<void> {
    const { store, config } = this.deps
    const promptCtx = { task, worktree: cwd, branch, askCommand: 'amagi ask "<question>"' }

    this.throwIfCancelled(task.id)
    this.transition(task.id, 'implementing')
    const first = await this.runAgentWithRetry(
      task.id,
      null,
      {
        cwd,
        prompt: resume ? reclaimPrompt(promptCtx) : implementPrompt(promptCtx),
        systemPrompt: implementSystemPrompt(promptCtx),
        ...harnessStartOpts(config.harness.implement),
      },
      lease,
    )
    if (first.stopped) return
    let sessionId = first.sessionId
    let summary = first.summary
    let model = first.model
    let effort = first.effort

    if (lease.isLost) throw new LeaseLostError(task.id)

    const parked = await this.parkAndResume(task.id, sessionId, cwd, lease)
    if (parked === null) return
    sessionId = parked.sessionId
    summary = parked.summary ?? summary
    model = parked.model ?? model
    effort = parked.effort ?? effort

    for (let round = 0; round <= config.loop.maxCheckRounds; round++) {
      this.throwIfCancelled(task.id)
      this.transition(task.id, 'checks')
      const results = await this.runChecks(cwd)
      const ok = results.every((r) => r.exitCode === 0)
      store.append(task.id, { type: 'checks.finished', ok, results })

      if (ok) break
      if (round === config.loop.maxCheckRounds) {
        this.transition(task.id, 'needs_human', 'project checks still failing')
        return
      }
      if (sessionId === null) {
        this.transition(
          task.id,
          'needs_human',
          'checks failed and the agent left no session to resume',
        )
        return
      }

      this.transition(task.id, 'implementing')
      const fix = await this.runAgentWithRetry(
        task.id,
        sessionId,
        {
          cwd,
          prompt: fixChecksPrompt(results),
          permissions: config.harness.implement.permissions,
          extraArgs: config.harness.implement.extraArgs,
        },
        lease,
      )
      if (fix.stopped) return
      sessionId = fix.sessionId
      summary = fix.summary
      model = fix.model
      effort = fix.effort
      if (lease.isLost) throw new LeaseLostError(task.id)

      const resumed = await this.parkAndResume(task.id, sessionId, cwd, lease)
      if (resumed === null) return
      sessionId = resumed.sessionId
      summary = resumed.summary ?? summary
      model = resumed.model ?? model
      effort = resumed.effort ?? effort
    }

    const committed = await this.commit(task, cwd)
    if (!committed) {
      let reason = summary?.trim() !== '' ? summary : null
      if (reason === null && sessionId !== null) {
        this.transition(task.id, 'implementing')
        const why = await this.runAgentWithRetry(
          task.id,
          sessionId,
          {
            cwd,
            prompt: whyNoChangesPrompt(task),
            permissions: config.harness.implement.permissions,
            extraArgs: config.harness.implement.extraArgs,
          },
          lease,
        )
        if (why.stopped) return
        reason = why.summary?.trim() !== '' ? why.summary : null
      }
      this.transition(
        task.id,
        'no_pr',
        reason ??
          'the agent produced no changes; the task may already be done or need no PR — ' +
            'verify and close it explicitly, it will not be closed automatically',
      )
      return
    }
    this.transition(task.id, 'committed')
    await this.openPullRequest(task, cwd, branch, model, effort)
    this.throwIfCancelled(task.id)
  }

  /**
   * Pushes the worktree branch and opens a pull request. A failed PR (gh not
   * authenticated, remote gone) leaves the commit in place and escalates, so
   * the operator can push and open it by hand.
   */
  private async openPullRequest(
    task: TrackerTask,
    cwd: string,
    branch: string,
    model: string | null,
    effort: string | null,
  ): Promise<void> {
    const { store, config } = this.deps
    const forge = this.deps.forge ?? makePrDriver(config.forge.kind, this.exec)
    const changes = await changesSinceBase(this.exec, cwd, config.repo.baseBranch)
    // The agent may have appended a how-to-use section to the task description
    // while implementing; re-read it so the PR body is not built from the stale
    // claim. Best effort: a failed re-read falls back to the claimed task.
    let current = task
    try {
      current = (await this.deps.tracker.get(task.id)) ?? task
    } catch {
      current = task
    }
    const opts: CreatePrOptions = {
      cwd,
      branch,
      base: config.repo.baseBranch,
      remote: config.forge.remote,
      title: prTitle(current),
      body: formatPrBody(current, changes, {
        harness: this.deps.harness.kind,
        model,
        effort,
      }),
      labels: amagiLabels(current.type),
    }
    try {
      const pr = await forge.createPr(opts)
      store.append(task.id, { type: 'pr.created', url: pr.url, number: pr.number })
      this.transition(task.id, 'pr_open')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const hint = /auth|login|token|not logged/i.test(message)
        ? ` (forge needs a token: set GH_TOKEN or FORGEJO_TOKEN in the amagi process environment)`
        : ''
      store.append(task.id, {
        type: 'error',
        message: `pull request: ${message}${hint}`,
        fatal: false,
      })
      this.transition(task.id, 'needs_human', 'pull request creation failed')
    }
  }

  /**
   * When the agent stopped because a question went unanswered, park and poll
   * the store until a human answers, then resume the recorded session with the
   * answer. Never answered within the window: escalate to needs_human.
   * Returns null to stop the whole run. The summary is the resumed run's
   * summary, or null when no agent ran (no question was parked). The server and
   * the runner share one SQLite file but not one process, so this polls rather
   * than subscribes.
   */
  private async parkAndResume(
    taskId: string,
    sessionId: string | null,
    cwd: string,
    lease: Lease,
  ): Promise<{
    sessionId: string | null
    summary: string | null
    model: string | null
    effort: string | null
  } | null> {
    const { store, config } = this.deps
    if (store.task(taskId)?.state !== 'awaiting_answer') {
      return { sessionId, summary: null, model: null, effort: null }
    }

    const question = store.unansweredQuestions(taskId)[0]
    if (question === undefined) return { sessionId, summary: null, model: null, effort: null }
    store.append(taskId, { type: 'question.parked', questionId: question.id })

    const deadline = Date.now() + config.loop.questionParkTimeoutSec * 1000
    while (Date.now() < deadline) {
      this.throwIfCancelled(taskId)
      if (lease.isLost) throw new LeaseLostError(taskId)
      const q = store.question(question.id)
      if (q !== null && q.answer !== null) {
        this.transition(taskId, 'implementing')
        if (sessionId === null) {
          this.transition(
            taskId,
            'needs_human',
            'the agent left no session to resume with the answer',
          )
          return null
        }
        const resumed = await this.runAgentWithRetry(
          taskId,
          sessionId,
          {
            cwd,
            prompt: answerPrompt(question.question, q.answer),
            permissions: config.harness.implement.permissions,
            extraArgs: config.harness.implement.extraArgs,
          },
          lease,
        )
        if (resumed.stopped) return null
        return {
          sessionId: resumed.sessionId,
          summary: resumed.summary,
          model: resumed.model,
          effort: resumed.effort,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, PARK_POLL_MS))
    }

    this.transition(taskId, 'needs_human', 'no answer within the parking window')
    return null
  }

  private async runAgent(
    taskId: string,
    resumeFrom: string | null,
    opts: Parameters<Harness['start']>[0],
  ): Promise<{
    sessionId: string | null
    ok: boolean
    detail: string | null
    summary: string | null
    model: string | null
    effort: string | null
  }> {
    const { store, harness } = this.deps
    const spawn = {
      ...opts,
      env: { AMAGI_TASK_TOKEN: store.token(taskId) },
    }
    const proc: AgentProcess =
      resumeFrom === null ? harness.start(spawn) : harness.resume(resumeFrom, spawn)
    this.currentProcess = proc

    try {
      // The resolved model only exists once the harness reports it (claude's
      // init line), so the started event lands on the first stream event.
      const model = proc.model ?? opts.model ?? null
      const effort = proc.effort ?? null
      let started = false
      for await (const event of proc.events()) {
        if (!started) {
          started = true
          store.append(taskId, {
            type: 'agent.started',
            role: 'implement',
            harness: harness.kind,
            model,
            effort,
            cwd: opts.cwd,
            resumed: resumeFrom !== null,
          })
        }
        store.append(taskId, { type: 'agent.stream', role: 'implement', event })
      }

      const outcome = await proc.done
      store.append(taskId, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
      })

      let detail: string | null = null
      if (!outcome.ok && !this.cancelled) {
        detail = outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`
        store.append(taskId, { type: 'error', message: `agent failed: ${detail}`, fatal: false })
      }
      return {
        sessionId: outcome.sessionId,
        ok: outcome.ok,
        detail,
        summary: outcome.summary,
        model,
        effort,
      }
    } finally {
      if (this.currentProcess === proc) this.currentProcess = null
    }
  }

  /**
   * Runs the agent, retrying transient failures (quota, rate limit, overloaded
   * model, flaky network) with an exponential backoff until the budget is
   * spent. The task sits in `retrying` between attempts so a crashed run is
   * visibly parked rather than silently committed. `stopped` means the run
   * must end: either the failure was operator-actionable, or retries ran out.
   */
  private async runAgentWithRetry(
    taskId: string,
    resumeFrom: string | null,
    opts: Parameters<Harness['start']>[0],
    lease: Lease,
  ): Promise<{
    sessionId: string | null
    stopped: boolean
    summary: string | null
    model: string | null
    effort: string | null
  }> {
    const { store, config } = this.deps
    let sessionId = resumeFrom
    let summary: string | null = null
    let model: string | null = null
    let effort: string | null = null

    for (let attempt = 1; ; attempt++) {
      const run = await this.runAgent(taskId, sessionId, opts)
      this.throwIfCancelled(taskId)
      sessionId = run.sessionId
      summary = run.summary
      model = run.model
      effort = run.effort
      if (run.ok) return { sessionId, stopped: false, summary, model, effort }
      if (lease.isLost) throw new LeaseLostError(taskId)

      if (!isTransientFailure(run.detail ?? '') || attempt > config.loop.maxRetries) {
        this.transition(taskId, 'needs_human', run.detail ?? 'agent failed')
        return { sessionId, stopped: true, summary, model, effort }
      }
      const delayMs = backoffDelayMs(config.loop.retryBaseMs, config.loop.retryMaxMs, attempt)
      store.append(taskId, {
        type: 'retry.scheduled',
        attempt,
        delayMs,
        reason: 'transient harness failure',
        detail: run.detail ?? '',
      })
      this.transition(taskId, 'retrying')
      // Polled so a stop interrupts the backoff instead of waiting it out.
      const deadline = Date.now() + delayMs
      while (Date.now() < deadline) {
        this.throwIfCancelled(taskId)
        await Bun.sleep(Math.min(100, deadline - Date.now()))
      }
      if (lease.isLost) throw new LeaseLostError(taskId)
      this.transition(taskId, 'implementing')
    }
  }

  private async runChecks(cwd: string): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    for (const command of this.deps.config.checks.commands) {
      const r = await this.exec(['sh', '-c', command], { cwd })
      results.push({
        command,
        exitCode: r.exitCode,
        output: `${r.stdout}${r.stderr}`.slice(-8000),
      })
      if (r.exitCode !== 0) break
    }
    return results
  }

  /** Returns false when the agent changed nothing, which is a failure worth surfacing. */
  private async commit(task: TrackerTask, cwd: string): Promise<boolean> {
    const status = await this.exec(['git', 'status', '--porcelain'], { cwd })
    if (status.stdout.trim() === '') return false

    await this.exec(['git', 'add', '-A'], { cwd })
    const message = commitMessage(task)
    const commit = await this.exec(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
    }

    const sha = (await this.exec(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
    this.deps.store.append(task.id, {
      type: 'commit.created',
      sha,
      subject: task.title,
    })
    return true
  }
}
