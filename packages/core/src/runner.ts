import { existsSync } from 'node:fs'
import type { Config } from './config.ts'
import { claimEligible, implementModel } from './difficulty.ts'
import { forgeToken, gitTokenConfig } from './drivers/forge-cred.ts'
import { amagiLabels, type CreatePrOptions, makePrDriver, type PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Harness, Tracker, TrackerTask } from './drivers/types.ts'
import { errMsg } from './errors.ts'
import { type CheckResult, isTerminal, type StoredEvent, type TaskState } from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts } from './factory.ts'
import { changesSinceBase, diffBase, formatPrBody } from './pr-body.ts'
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
import { backoffDelayMs, isSessionLimit, isTransientFailure } from './retry.ts'
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

/**
 * The session, summary, model and effort an agent run leaves behind. Every
 * agent phase produces one of these and later phases merge into it.
 */
type AgentRun = {
  sessionId: string | null
  summary: string | null
  model: string | null
  effort: string | null
}

/** Merge a newer run into the accumulated state, keeping the earlier value where the newer run is null. */
function mergeAgentRuns(prev: AgentRun, next: AgentRun): AgentRun {
  return {
    sessionId: next.sessionId,
    summary: next.summary ?? prev.summary,
    model: next.model ?? prev.model,
    effort: next.effort ?? prev.effort,
  }
}

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

/** Thrown once a task blows its wall-clock or cost budget; parked at needs_human. */
class BudgetExhaustedError extends Error {
  constructor(taskId: string, reason: string) {
    super(`task ${taskId}: budget exhausted: ${reason}`)
    this.name = 'BudgetExhaustedError'
  }
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (parts.length === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

/** Total usage cost and whether any usage event carried a dollar figure, from the persisted log. */
function taskCost(events: StoredEvent[]): { costUsd: number; costSeen: boolean } {
  let costUsd = 0
  let costSeen = false
  for (const e of events) {
    if (e.type === 'agent.stream' && e.event.kind === 'usage' && e.event.costUsd !== undefined) {
      costUsd += e.event.costUsd
      costSeen = true
    }
  }
  return { costUsd, costSeen }
}

/**
 * Per-task wall-clock and cost ceiling, cumulative across every round and
 * reclaim. A value of 0 for a limit means unbounded. The cost budget is only
 * enforced once the harness actually reports cost (claude, opencode); a
 * harness without a dollar figure (codex) skips it rather than counting zero.
 */
class TaskBudget {
  constructor(
    private readonly startedAt: number,
    private readonly maxRunMs: number,
    private readonly maxCostUsd: number,
    private costUsd = 0,
    private costSeen = false,
  ) {}

  elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  addCost(costUsd: number): void {
    this.costUsd += costUsd
    this.costSeen = true
  }

  /** The reason the budget is spent, or null while still within limits. */
  spentReason(): string | null {
    const elapsed = this.elapsedMs()
    if (this.maxRunMs > 0 && elapsed >= this.maxRunMs) {
      return `max run time of ${formatDuration(this.maxRunMs)} exceeded after ${formatDuration(elapsed)}`
    }
    if (this.maxCostUsd > 0 && this.costSeen && this.costUsd >= this.maxCostUsd) {
      return `max cost of $${this.maxCostUsd.toFixed(2)} exceeded after $${this.costUsd.toFixed(2)}`
    }
    return null
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
  /** Set once the store flips the task to `cancelled`; guards the unwind. */
  private cancelled = false
  private retryNowRequested = false
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

  /**
   * Wake a task sleeping out its retry backoff so the next attempt starts
   * immediately instead of waiting out the full delay. No-op while the agent
   * is live or the task is not deferring a retry.
   */
  retryNow(): void {
    this.retryNowRequested = true
  }

  /** The pid of the live agent process, or null between agent phases. */
  currentPid(): number | null {
    return this.currentProcess?.pid ?? null
  }

  private throwIfCancelled(taskId: string): void {
    if (this.cancelled) throw new RunCancelledError(taskId)
  }

  private throwIfBudgetExhausted(taskId: string, budget: TaskBudget): void {
    const spent = budget.spentReason()
    if (spent !== null) throw new BudgetExhaustedError(taskId, spent)
  }

  /**
   * Claims the next ready task (or the given one, for `amagi continue`) and
   * drives it as far as the current milestone goes.
   */
  async runOnce(taskId?: string): Promise<RunOnceResult> {
    const { store, tracker, config } = this.deps
    const task =
      taskId === undefined
        ? await claimEligible(tracker, config, implementModel(config), (skipped, reason) => {
            store.append(null, {
              type: 'claim.rejected',
              title: skipped.title,
              difficulty: skipped.difficulty ?? null,
              reason,
            })
          })
        : await tracker.claim(taskId)
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
        const message = errMsg(err)
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
      console.warn(`release ${taskId}: ${errMsg(err)}`)
    }
  }

  private transition(taskId: string, to: TaskState, reason?: string): void {
    const from = this.deps.store.task(taskId)?.state ?? null
    if (from === to) return
    // An external actor (the doom guard) may have parked the task in a
    // terminal state mid-run; once parked, further in-run transitions are
    // no-ops so the runner unwinds cleanly instead of throwing an illegal
    // transition.
    if (from !== null && isTerminal(from)) return
    this.deps.store.append(taskId, {
      type: 'task.state',
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  /** Whether the operator interrupted the run via the store's `cancelled` state. */
  private isCancelled(taskId: string): boolean {
    return this.cancelled || this.deps.store.task(taskId)?.state === 'cancelled'
  }

  private async drive(task: TrackerTask): Promise<void> {
    const { store, config } = this.deps

    const prior = taskCost(store.events({ taskId: task.id, limit: 1_000_000 }))
    const budget = new TaskBudget(
      store.task(task.id)?.createdAt ?? Date.now(),
      config.loop.maxRunMinutes * 60_000,
      config.loop.maxCostUsd,
      prior.costUsd,
      prior.costSeen,
    )

    // A reclaimed task already has its worktree and branch recorded in the
    // store; reuse them instead of creating a fresh worktree.
    const recorded = store.task(task.id)
    const recordedWorktree =
      recorded !== null && recorded.worktree !== null && recorded.branch !== null
        ? { path: recorded.worktree, branch: recorded.branch }
        : null
    // Reuse only what still exists on disk: a reboot that cleared the worktree
    // root must fall back to a fresh worktree, not run the agent in a dir that
    // is gone.
    const resume = recordedWorktree !== null && existsSync(recordedWorktree.path)

    let worktree: WorktreeSpec
    if (recordedWorktree !== null && resume) {
      worktree = recordedWorktree
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
      await this.implementAndCheck(task, worktree.path, worktree.branch, lease, budget, resume)
    } finally {
      lease.stop()
    }
  }

  private async implementAndCheck(
    task: TrackerTask,
    cwd: string,
    branch: string,
    lease: Lease,
    budget: TaskBudget,
    resume = false,
  ): Promise<void> {
    const { store, config } = this.deps
    const promptCtx = { task, worktree: cwd, branch, askCommand: 'amagi ask "<question>"' }

    this.throwIfCancelled(task.id)
    this.throwIfBudgetExhausted(task.id, budget)
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
      'implement',
      lease,
      budget,
    )
    if (first.stopped) return
    let current: AgentRun = {
      sessionId: first.sessionId,
      summary: first.summary,
      model: first.model,
      effort: first.effort,
    }

    if (lease.isLost) throw new LeaseLostError(task.id)

    const parked = await this.parkAndResume(task.id, current.sessionId, cwd, lease, budget)
    if (parked === null) return
    current = mergeAgentRuns(current, parked)

    let recoveryGiven = false
    let recoveryRetry = false
    for (let round = 0; round <= config.loop.maxCheckRounds; round++) {
      this.throwIfCancelled(task.id)
      this.transition(task.id, 'checks')
      const results = await this.runChecks(cwd)
      this.throwIfBudgetExhausted(task.id, budget)
      const ok = results.every((r) => r.exitCode === 0)
      store.append(task.id, { type: 'checks.finished', ok, results })

      if (ok) break
      // The fix rounds are spent, or nothing is left to resume. Rather than
      // parking the task silently (a stale worktree makes checks fail that a
      // fresh base passes), ask the operator once how to proceed and apply it.
      if (round === config.loop.maxCheckRounds || (current.sessionId === null && !recoveryRetry)) {
        if (!recoveryGiven) {
          recoveryGiven = true
          const action = await this.recoverFailingChecks(task.id, results, lease, budget)
          if (action === null) return
          if (action === 'park') {
            this.transition(task.id, 'needs_human', 'project checks still failing')
            return
          }
          if (action === 'rebase') {
            const rebased = await this.updateFromBase(cwd)
            if (!rebased) {
              this.transition(
                task.id,
                'needs_human',
                'project checks still failing; updating the worktree to the latest base failed',
              )
              return
            }
          }
          // 'retry' or a successful 'rebase': give the fix rounds another full
          // pass, resuming the recorded session or starting a fresh one.
          recoveryRetry = true
          round = -1
          continue
        }
        this.transition(task.id, 'needs_human', 'project checks still failing')
        return
      }

      this.transition(task.id, 'implementing')
      const fix = await this.runAgentWithRetry(
        task.id,
        current.sessionId,
        {
          cwd,
          prompt: fixChecksPrompt(results),
          permissions: config.harness.implement.permissions,
          extraArgs: config.harness.implement.extraArgs,
        },
        'fix checks',
        lease,
        budget,
      )
      if (fix.stopped) return
      current = mergeAgentRuns(current, fix)
      if (lease.isLost) throw new LeaseLostError(task.id)

      const resumed = await this.parkAndResume(task.id, current.sessionId, cwd, lease, budget)
      if (resumed === null) return
      current = mergeAgentRuns(current, resumed)
    }

    const committed = await this.commit(task, cwd, config.repo.baseBranch)
    if (!committed) {
      let reason = current.summary?.trim() !== '' ? current.summary : null
      if (reason === null && current.sessionId !== null) {
        this.transition(task.id, 'implementing')
        const why = await this.runAgentWithRetry(
          task.id,
          current.sessionId,
          {
            cwd,
            prompt: whyNoChangesPrompt(task),
            permissions: config.harness.implement.permissions,
            extraArgs: config.harness.implement.extraArgs,
          },
          'why no changes',
          lease,
          budget,
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
    await this.openPullRequest(task, cwd, branch, current.model, current.effort, current.summary)
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
    summary: string | null,
  ): Promise<void> {
    const { store, config } = this.deps
    const forge = this.deps.forge ?? makePrDriver(config.forge.kind, this.exec)
    const changes = await changesSinceBase(this.exec, cwd, config.repo.baseBranch)
    if (changes.length === 0) {
      // The worktree was dirty and a commit was made, yet the three-dot diff
      // against the base is empty: the agent re-applied change already on the
      // base. Nothing to push, so no PR. Distinct from the 'produced no
      // changes' reason: that agent did nothing, this one duplicated existing
      // work.
      this.transition(
        task.id,
        'no_pr',
        `the agent committed, but the diff against ${config.repo.baseBranch} is empty; ` +
          `the work is probably already on ${config.repo.baseBranch}`,
      )
      return
    }
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
      body: formatPrBody(
        current,
        changes,
        {
          harness: this.deps.harness.kind,
          model,
          effort,
        },
        summary,
      ),
      labels: amagiLabels(current.type),
    }
    try {
      const pr = await forge.createPr(opts)
      store.append(task.id, { type: 'pr.created', url: pr.url, number: pr.number })
      this.transition(task.id, 'pr_open')
    } catch (err) {
      const message = errMsg(err)
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
    budget: TaskBudget,
  ): Promise<AgentRun | null> {
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
      this.throwIfBudgetExhausted(taskId, budget)
      if (lease.isLost) throw new LeaseLostError(taskId)
      if (this.isCancelled(taskId)) return null
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
          'implement',
          lease,
          budget,
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
    phase: string,
    budget: TaskBudget,
  ): Promise<AgentRun & { ok: boolean; detail: string | null }> {
    const { store, harness } = this.deps
    const spawn = {
      ...opts,
      env: { AMAGI_TASK_TOKEN: store.token(taskId) },
    }
    const proc: AgentProcess =
      resumeFrom === null ? harness.start(spawn) : harness.resume(resumeFrom, spawn)
    this.currentProcess = proc

    // The store is the shared interrupt channel: `amagi stop` or the API parks
    // the task in `cancelled`, and this poll kills the agent process so a hung
    // harness is stopped without reaching into the runner process.
    const cancelWatch = setInterval(() => {
      if (store.task(taskId)?.state !== 'cancelled') return
      this.cancelled = true
      clearInterval(cancelWatch)
      void proc.kill()
    }, 500)

    // The stream is persisted anyway, so a failure is mined from what the
    // agent actually said or did instead of a bare exit code.
    let lastText: string | null = null
    let lastToolError: string | null = null
    let resultSummary: string | null = null
    let errorMessage: string | null = null
    let budgetSpent: string | null = null

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
        if (event.kind === 'usage' && event.costUsd !== undefined) budget.addCost(event.costUsd)
        switch (event.kind) {
          case 'text':
            lastText = event.text
            break
          case 'tool_result':
            if (!event.ok) lastToolError = event.output
            break
          case 'result':
            resultSummary = event.summary ?? resultSummary
            break
          case 'error':
            errorMessage = event.message
            break
        }
        store.append(taskId, { type: 'agent.stream', role: 'implement', event })
        const spent = budget.spentReason()
        if (spent !== null) {
          budgetSpent = spent
          try {
            await proc.kill()
          } catch {
            // The budget stop stands even when the kill races the process's own exit.
          }
          break
        }
      }

      clearInterval(cancelWatch)

      const outcome = await proc.done
      store.append(taskId, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
      })
      if (budgetSpent !== null) throw new BudgetExhaustedError(taskId, budgetSpent)

      let detail: string | null = null
      if (!outcome.ok && !this.cancelled) {
        detail =
          outcome.stderr.trim() ||
          resultSummary ||
          errorMessage ||
          lastToolError ||
          lastText ||
          `${phase} phase failed (exit ${outcome.exitCode}); see the task log in the dashboard for the full trace`
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
      clearInterval(cancelWatch)
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
    phase: string,
    lease: Lease,
    budget: TaskBudget,
  ): Promise<AgentRun & { stopped: boolean }> {
    const { store, config } = this.deps
    let sessionId = resumeFrom
    let summary: string | null = null
    let model: string | null = null
    let effort: string | null = null

    for (let attempt = 1; ; attempt++) {
      const run = await this.runAgent(taskId, sessionId, opts, phase, budget)
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
      // A session that hit its own limit (turn/context window) is spent and
      // cannot be resumed; the retry starts a fresh session in the same worktree.
      if (isSessionLimit(run.detail ?? '')) sessionId = null
      this.transition(taskId, 'retrying')
      // Polled so a stop interrupts the backoff instead of waiting it out,
      // and a retry-now request skips the wait for an immediate retry.
      this.retryNowRequested = false
      const deadline = Date.now() + delayMs
      while (Date.now() < deadline) {
        this.throwIfCancelled(taskId)
        if (this.retryNowRequested) break
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

  /**
   * Checks failed at the end of the fix rounds. Instead of parking the task
   * silently, ask the operator how to proceed and apply the answer. Returns
   * the chosen action, or null when the run must stop (cancelled, budget
   * spent, or no answer within the parking window).
   */
  private async recoverFailingChecks(
    taskId: string,
    results: CheckResult[],
    lease: Lease,
    budget: TaskBudget,
  ): Promise<'retry' | 'rebase' | 'park' | null> {
    const { store, config } = this.deps
    const failed = results.filter((r) => r.exitCode !== 0)
    const detail = failed
      .map((r) => `$ ${r.command}\nexit ${r.exitCode}\n${r.output.trim()}`)
      .join('\n')
    const question = [
      'Project checks still failing. The agent could not fix them.',
      '',
      detail,
      '',
      'How should I proceed?',
    ].join('\n')
    const options = [
      'retry: run another fix round',
      'rebase: update the worktree from the latest base and retry',
      'park: park the task for manual attention',
    ]

    const questionId = crypto.randomUUID()
    this.transition(taskId, 'implementing')
    store.append(taskId, { type: 'question.asked', questionId, question, options, gateRef: null })
    this.transition(taskId, 'awaiting_answer')

    const deadline = Date.now() + config.loop.questionParkTimeoutSec * 1000
    while (Date.now() < deadline) {
      this.throwIfCancelled(taskId)
      this.throwIfBudgetExhausted(taskId, budget)
      if (lease.isLost) throw new LeaseLostError(taskId)
      if (this.isCancelled(taskId)) return null
      const q = store.question(questionId)
      if (q !== null && q.answer !== null) {
        this.transition(taskId, 'implementing')
        if (/^rebase\b/.test(q.answer)) return 'rebase'
        if (/^retry\b/.test(q.answer)) return 'retry'
        return 'park'
      }
      await new Promise((resolve) => setTimeout(resolve, PARK_POLL_MS))
    }

    this.transition(taskId, 'needs_human', 'no answer within the parking window')
    return null
  }

  /**
   * Brings the worktree up to date with the latest base branch, preserving the
   * agent's uncommitted changes. A stale worktree (checks that pass on a fresh
   * base, or a recipe the base added after this worktree was created) is the
   * usual reason checks fail that a fresh base would pass. False when anything
   * fails (network, conflicts), leaving the worktree untouched.
   */
  private async updateFromBase(cwd: string): Promise<boolean> {
    const { config } = this.deps
    const tokenCfg = await gitTokenConfig(
      this.exec,
      this.deps.repoRoot,
      config.forge.remote,
      forgeToken(config.forge.kind),
    )
    const fetch = await this.exec(['git', ...tokenCfg, 'fetch', 'origin', config.repo.baseBranch], {
      cwd,
    })
    if (fetch.exitCode !== 0) return false

    const dirty = (await this.exec(['git', 'status', '--porcelain'], { cwd })).stdout.trim() !== ''
    const stashed =
      dirty && (await this.exec(['git', 'stash', 'push', '-u'], { cwd })).exitCode === 0
    if (dirty && !stashed) return false

    const rebase = await this.exec(['git', 'rebase', `origin/${config.repo.baseBranch}`], { cwd })
    if (rebase.exitCode !== 0) {
      await this.exec(['git', 'rebase', '--abort'], { cwd })
      if (stashed) await this.exec(['git', 'stash', 'pop'], { cwd })
      return false
    }
    if (stashed) {
      const pop = await this.exec(['git', 'stash', 'pop'], { cwd })
      if (pop.exitCode !== 0) return false
    }
    return true
  }

  /** Returns false when the agent changed nothing, which is a failure worth surfacing. */
  private async commit(task: TrackerTask, cwd: string, base: string): Promise<boolean> {
    const status = await this.exec(['git', 'status', '--porcelain'], { cwd })
    if (status.stdout.trim() !== '') {
      await this.exec(['git', 'add', '-A'], { cwd })
      const message = commitMessage(task)
      const commit = await this.exec(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
      if (commit.exitCode !== 0) {
        throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
      }
    }

    // A clean worktree may still hold the agent's own commit from the session;
    // HEAD ahead of the base is work worth a PR, not the no_changes case.
    const ref = await diffBase(this.exec, cwd, base)
    const ahead = await this.exec(['git', 'rev-list', '--count', `${ref}..HEAD`], { cwd })
    if (ahead.exitCode !== 0 || Number(ahead.stdout.trim()) === 0) return false

    const sha = (await this.exec(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
    this.deps.store.append(task.id, {
      type: 'commit.created',
      sha,
      subject: task.title,
    })
    return true
  }
}
