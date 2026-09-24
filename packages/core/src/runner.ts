import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import type { Config } from './config.ts'
import { claimEligible, implementModel } from './difficulty.ts'
import { forgeToken, gitTokenConfig } from './drivers/forge-cred.ts'
import { amagiLabels, type CreatePrOptions, makePrDriver, type PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Harness, Tracker, TrackerTask } from './drivers/types.ts'
import { errMsg } from './errors.ts'
import {
  type AgentEvent,
  type AgentRole,
  type CheckResult,
  currentAttemptEvents,
  isTerminal,
  type StoredEvent,
  type TaskState,
} from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts } from './factory.ts'
import { rejectedGitLogPath, runStateDir } from './paths.ts'
import { changesSinceBase, diffBase, formatPrBody, withAgentSections } from './pr-body.ts'
import {
  answerPrompt,
  commitMessage,
  fixChecksPrompt,
  implementAfterVerifyPrompt,
  implementPrompt,
  implementSystemPrompt,
  prFailurePrompt,
  prFailureSystemPrompt,
  prTitle,
  reclaimPrompt,
  verifyViabilityPrompt,
  verifyViabilitySystemPrompt,
  whyNoChangesPrompt,
  withRestartHandoff,
} from './prompt.ts'
import { backoffDelayMs, isSessionLimit, isTransientFailure } from './retry.ts'
import type { ProjectedTask, Store } from './store/store.ts'
import { parseVerdict, type Verdict, withVerdictLine } from './verdict.ts'
import { createWorktree, type WorktreeSpec } from './worktree.ts'

export type RunnerDeps = {
  store: Store
  tracker: Tracker
  harness: Harness
  config: Config
  repoRoot: string
  repoName: string
  exec?: Exec | undefined
  /** Overridable so tests do not need gh installed. Defaults to the configured forge driver. */
  forge?: PrDriver | undefined
  /** Lease heartbeat cadence override for tests; defaults to a third of the tracker TTL. */
  leaseHeartbeatMs?: number
  /**
   * True when a server channel exists (amagi serve), so the agent is told
   * about ask and git-request. A standalone amagi run has no server to POST
   * to, so its agent is not told about either.
   */
  channel?: boolean
}

export type RunOnceResult = {
  task: ProjectedTask
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

/** Best-effort JSON extraction of the viability decision; anything else is a null. */
function parseViabilityDecision(
  reply: string,
): { viable: boolean; reason: string; verdict: Verdict | null } | null {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (typeof parsed !== 'object' || parsed === null) return null
    const viable = (parsed as { viable?: unknown }).viable
    if (typeof viable !== 'boolean') return null
    const reason = (parsed as { reason?: unknown }).reason
    const verdict = (parsed as { verdict?: unknown }).verdict
    return {
      viable,
      reason: typeof reason === 'string' ? reason : '',
      verdict: typeof verdict === 'string' ? parseVerdict(`Verdict: ${verdict}`) : null,
    }
  } catch {
    return null
  }
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
    private readonly heartbeatMs?: number,
  ) {}

  start(): void {
    const period = this.heartbeatMs ?? Math.max(30_000, Math.floor(this.tracker.leaseTtlMs / 3))
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
  /** Running peak input context of a single model request in the current task run. */
  private peakContext = 0
  /** Whether the soft context limit has been flagged for the current task run. */
  private contextWarned = false
  /** Fresh-context restarts already spent on the current task run, across all phases. */
  private contextRestarts = 0

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
    const pid = this.currentProcess?.pid
    return pid !== undefined && pid > 0 ? pid : null
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
    this.peakContext = 0
    this.contextWarned = false
    this.contextRestarts = 0
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
    const { warnTokens, maxTokens } = this.contextLimits()
    store.append(task.id, {
      type: 'run.limits',
      contextWarnTokens: warnTokens,
      contextMaxTokens: maxTokens,
      maxRunMs: this.deps.config.loop.maxRunMinutes * 60_000,
      maxCostUsd: this.deps.config.loop.maxCostUsd,
    })

    try {
      await this.drive(task)
    } catch (err) {
      if (err instanceof RunCancelledError) {
        await this.finishCancelled(task.id)
      } else if (err instanceof LeaseLostError) {
        // The tracker claim was reclaimed (stall watcher recovery, bd reclaim,
        // or another worker took over). Stop before colliding with the new
        // owner and leave the task where the reclaim parked it: either the new
        // worker drives it, or the next one resumes its recorded worktree, so no
        // human attention is needed.
        store.append(task.id, { type: 'error', message: errMsg(err), fatal: false })
      } else {
        const message = errMsg(err)
        store.append(task.id, { type: 'error', message, fatal: true })
        this.transition(task.id, 'needs_human', message)
      }
    } finally {
      // Best effort: surface the shim's rejected git attempts next to the
      // run's own commit/pr events, so a rule-fighting agent is visible
      // without a chat session to discover it.
      await this.drainGitBlocked(task.id)
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
      reason,
    })
  }

  /** Whether the operator interrupted the run via the store's `cancelled` state. */
  private isCancelled(taskId: string): boolean {
    return this.cancelled || this.deps.store.task(taskId)?.state === 'cancelled'
  }

  private async drive(task: TrackerTask): Promise<void> {
    const { store, config } = this.deps

    const prior = taskCost(
      currentAttemptEvents(store.events({ taskId: task.id, limit: 1_000_000 }), task.id),
    )
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

    const lease = new Lease(this.deps.tracker, this.deps.store, task.id, this.deps.leaseHeartbeatMs)
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
    // The claimed task is a lite ready row without notes or comments; re-read the
    // full issue so the agent sees the tracker context (and never needs bd inside
    // the worktree, where it has no database). Best effort, like the PR-body re-read.
    let currentTask = task
    try {
      currentTask = (await this.deps.tracker.get(task.id)) ?? task
    } catch {
      currentTask = task
    }
    const promptCtx = {
      task: currentTask,
      worktree: cwd,
      branch,
      // The channel commands only exist under amagi serve, so a standalone run
      // is never told to use them.
      ...(this.deps.channel ? { askCommand: 'amagi ask "<question>"' } : {}),
      ...(this.deps.channel ? { gitRequestCommand: 'amagi git-request commit' } : {}),
      baseBranch: config.repo.baseBranch,
      checks: this.checkCommands(),
    }

    this.throwIfCancelled(task.id)
    this.throwIfBudgetExhausted(task.id, budget)
    this.transition(task.id, 'implementing')
    // A fresh run first verifies the task is still viable against the current
    // repository, so a task already satisfied on the base branch is stopped
    // before the implement agent writes anything or a no-op PR is opened. A
    // resumed run skips the check: its worktree already holds in-progress work.
    // Implement resumes the check's session so its exploration is not redone.
    let verifySession: string | null = null
    if (!resume) {
      const verified = await this.verifyViability(task, cwd, branch, budget)
      if (verified === null) return
      verifySession = verified.sessionId
    }
    const first = await this.runAgentWithRetry(
      task.id,
      verifySession,
      {
        cwd,
        prompt: resume
          ? reclaimPrompt(promptCtx)
          : verifySession !== null
            ? implementAfterVerifyPrompt(promptCtx)
            : implementPrompt(promptCtx),
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
      // The verdict is what the operator acts on for a task with no PR, so a
      // summary that skipped it sends the agent back to classify the outcome.
      if (parseVerdict(reason) === null && current.sessionId !== null) {
        this.transition(task.id, 'implementing')
        const why = await this.runAgentWithRetry(
          task.id,
          current.sessionId,
          {
            cwd,
            prompt: whyNoChangesPrompt(currentTask),
            permissions: config.harness.implement.permissions,
            extraArgs: config.harness.implement.extraArgs,
          },
          'why no changes',
          lease,
          budget,
        )
        if (why.stopped) return
        if (why.summary?.trim()) reason = why.summary
      }
      // No changes AND no agent-written explanation: never read as "already done".
      this.transition(
        task.id,
        'no_pr',
        withVerdictLine(
          reason ??
            'the agent produced no changes and wrote no summary explaining why; treat ' +
              'this as unverified rather than done — investigate before closing, it will ' +
              'not be closed automatically',
        ),
      )
      return
    }
    this.transition(task.id, 'committed')
    await this.openPullRequest(
      task,
      cwd,
      branch,
      current.sessionId,
      budget,
      current.model,
      current.effort,
      current.summary,
    )
    this.throwIfCancelled(task.id)
  }

  /**
   * Pre-implement viability check: a read-only agent pass decides whether the
   * task is still needed in the current repository. Returns false when the
   * task is not viable, in which case it is reported inside the task (a
   * tracker comment) and parked in `no_pr` before any code is written. Any
   * failure to check defaults to viable: a broken check must never kill a
   * task, only a clear not-viable verdict does. A viable verdict carries the
   * check's session for implement to resume; a failed check carries none.
   */
  private async verifyViability(
    task: TrackerTask,
    cwd: string,
    branch: string,
    budget: TaskBudget,
  ): Promise<{ sessionId: string | null } | null> {
    const { store, config } = this.deps
    const run = await this.runAgent(
      task.id,
      null,
      {
        cwd,
        prompt: verifyViabilityPrompt({ task, worktree: cwd, branch, askCommand: null }),
        systemPrompt: verifyViabilitySystemPrompt(),
        ...harnessStartOpts(config.harness.implement),
      },
      'verify',
      budget,
      'verify',
    )
    if (!run.ok) {
      // A cancel mid-check must stop the run, not fall through to implement.
      this.throwIfCancelled(task.id)
      return { sessionId: null }
    }
    const decision = run.summary === null ? null : parseViabilityDecision(run.summary)
    if (decision === null || decision.viable) return { sessionId: run.sessionId }

    const reason =
      decision.reason.trim() !== ''
        ? decision.reason
        : 'the task is not viable against the current repository'
    const verdict = decision.verdict ?? 'close-task'
    try {
      await this.deps.tracker.comment(
        task.id,
        `amagi: task ${task.id} skipped as no longer viable - ${reason}\n\nVerdict: ${verdict}`,
      )
    } catch (err) {
      store.append(task.id, {
        type: 'error',
        message: `viability comment ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        fatal: false,
      })
    }
    this.transition(task.id, 'no_pr', withVerdictLine(reason, verdict))
    return null
  }

  /**
   * Pushes the worktree branch and opens a pull request. A failed PR leaves the
   * commit in place; a read-only diagnosis tells the operator how to proceed.
   */
  private async openPullRequest(
    task: TrackerTask,
    cwd: string,
    branch: string,
    sessionId: string | null,
    budget: TaskBudget,
    model: string | null,
    effort: string | null,
    fallbackSummary?: string | null,
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
        withVerdictLine(
          `the agent committed, but the diff against ${config.repo.baseBranch} is empty; ` +
            `the work is probably already on ${config.repo.baseBranch}`,
          'close-task',
        ),
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
    let summary = fallbackSummary
    const sections = withAgentSections(current.description, fallbackSummary)
    if (sections !== null) {
      summary = sections.summary
      current = { ...current, description: sections.description }
      if (this.deps.tracker.capabilities.edit) {
        try {
          await this.deps.tracker.updateTask(task.id, { description: sections.description })
        } catch (err) {
          store.append(task.id, {
            type: 'error',
            message: `writing the PR sections into ${task.id} failed: ${errMsg(err)}`,
            fatal: false,
          })
        }
      }
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
          // Fall back to the configured implement model/effort when the run
          // reports none (fix/resume rounds do not carry one), mirroring the
          // comment footer so the PR body always carries the same provenance.
          model: model ?? config.harness.implement.model ?? null,
          effort: effort ?? config.harness.implement.effort ?? null,
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
      let reason: string | null = null
      try {
        const diagnosis = await this.runAgent(
          task.id,
          sessionId,
          {
            cwd,
            prompt: prFailurePrompt(current, branch, `${message}${hint}`),
            systemPrompt: prFailureSystemPrompt(),
            ...harnessStartOpts(config.harness.implement),
          },
          'PR failure diagnosis',
          budget,
          'verify',
        )
        this.throwIfCancelled(task.id)
        if (diagnosis.ok) reason = diagnosis.summary?.trim() || null
      } catch {
        this.throwIfCancelled(task.id)
      }
      this.transition(task.id, 'needs_human', reason ?? `${message}${hint}`)
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
    role: AgentRole = 'implement',
  ): Promise<{
    sessionId: string | null
    ok: boolean
    detail: string | null
    summary: string | null
    model: string | null
    effort: string | null
    contextExceeded: boolean
  }> {
    const { store, harness } = this.deps
    const runState = runStateDir(taskId)
    mkdirSync(runState, { recursive: true })
    const spawn = {
      ...opts,
      ...(opts.seat !== undefined
        ? {}
        : this.deps.config.harness.implement.seat === undefined
          ? {}
          : { seat: this.deps.config.harness.implement.seat }),
      env: {
        AMAGI_TASK_TOKEN: store.token(taskId),
        // The git shim scopes itself to the task worktree and the main
        // checkout, and logs rejected calls into the run state dir.
        AMAGI_WORKTREE: opts.cwd,
        AMAGI_REPO_ROOT: this.deps.repoRoot,
        AMAGI_RUN_STATE: runState,
      },
    }
    const reflogBefore = await this.headReflog(opts.cwd)
    this.throwIfCancelled(taskId)
    const seqBefore = store.recentEvents(taskId, 1)[0]?.seq ?? 0
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
      const effort = proc.effort ?? null
      let model = opts.model ?? null
      let started = false
      let contextExceeded = false
      for await (const event of proc.events()) {
        if (!started && event.kind !== 'status') {
          started = true
          model = proc.model ?? opts.model ?? null
          store.append(taskId, {
            type: 'agent.started',
            role,
            harness: harness.kind,
            seat: spawn.seat ?? harness.kind,
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
        if (event.kind !== 'context') {
          store.append(taskId, {
            type: 'agent.stream',
            role,
            event: event.kind === 'usage' ? { ...event, seat: spawn.seat ?? harness.kind } : event,
          })
        }
        if (this.observeContext(taskId, event)) {
          // Hard limit reached: stop the agent now rather than let it degrade.
          contextExceeded = true
          await proc.kill()
          break
        }
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
        role,
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
      })
      if (budgetSpent !== null) throw new BudgetExhaustedError(taskId, budgetSpent)

      let detail: string | null = null
      if (!outcome.ok && !this.cancelled && !contextExceeded) {
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
        contextExceeded,
      }
    } finally {
      if (this.currentProcess === proc) this.currentProcess = null
      clearInterval(cancelWatch)
      await this.recordGitBypass(taskId, opts.cwd, reflogBefore, seqBefore)
    }
  }

  /** HEAD reflog of `cwd` as `<sha> <subject>` lines, newest first; null when unreadable. */
  private async headReflog(cwd: string): Promise<string[] | null> {
    const r = await this.exec(['git', 'reflog', 'show', '--format=%H %gs', 'HEAD'], { cwd })
    if (r.exitCode !== 0) return null
    return r.stdout.split('\n').filter((l) => l !== '')
  }

  /**
   * Records `git.bypassed` when the worktree's HEAD reflog grew during an agent
   * run by entries the runner did not make. Commits recorded as `commit.created`
   * since `sinceSeq` are the sanctioned `git-request` ones.
   */
  private async recordGitBypass(
    taskId: string,
    cwd: string,
    before: string[] | null,
    sinceSeq: number,
  ): Promise<void> {
    try {
      const after = await this.headReflog(cwd)
      if (before === null || after === null) return
      const { store } = this.deps
      const sanctioned = new Set(
        store
          .events({ taskId, sinceSeq, limit: 1_000_000 })
          .flatMap((e) => (e.type === 'commit.created' ? [e.sha] : [])),
      )
      const entries = after
        .slice(0, Math.max(0, after.length - before.length))
        .filter((line) => !sanctioned.has(line.split(' ', 1)[0] ?? ''))
      if (entries.length > 0) store.append(taskId, { type: 'git.bypassed', entries })
    } catch {
      // Best effort: the bypass check never fails the run.
    }
  }

  /**
   * Effective context budget for the active harness: per-harness overrides win
   * over the loop defaults, since context windows differ between harnesses.
   */
  private contextLimits(): { warnTokens: number; maxTokens: number } {
    const { config, harness } = this.deps
    const overrides = config.loop.contextOverrides[harness.kind] ?? {}
    return {
      warnTokens: overrides.warnTokens ?? config.loop.contextWarnTokens,
      maxTokens: overrides.maxTokens ?? config.loop.contextMaxTokens,
    }
  }

  /**
   * Folds a streamed context event into the run's peak context and enforces the
   * budget. Returns true when the hard limit was crossed, signalling the
   * caller to kill the agent.
   */
  private observeContext(taskId: string, event: AgentEvent): boolean {
    if (event.kind !== 'context') return false
    const { store } = this.deps
    const { warnTokens, maxTokens } = this.contextLimits()
    const context = event.tokens
    if (context <= this.peakContext) return false
    this.peakContext = context
    store.append(taskId, { type: 'run.context', contextTokens: context })
    if (!this.contextWarned && context >= warnTokens) {
      this.contextWarned = true
      store.append(taskId, { type: 'context.warn', contextTokens: context, limit: warnTokens })
    }
    if (context >= maxTokens) {
      store.append(taskId, { type: 'context.exceeded', contextTokens: context, limit: maxTokens })
      return true
    }
    return false
  }

  /**
   * Synthesizes a short handoff of what a killed session did, for the fresh
   * session replacing it: the last thing the agent reported (text or result
   * summary) plus the files its work left in the worktree. The new session
   * reads this instead of the dead session's context, so it can pick up the
   * work without redoing it.
   */
  private async handoffSummary(taskId: string, cwd: string): Promise<string> {
    const lines: string[] = []
    const events = this.deps.store.recentEvents(taskId, 200)
    for (const event of events.slice().reverse()) {
      if (event.type !== 'agent.stream') continue
      if (event.event.kind === 'text' && event.event.text.trim() !== '') {
        lines.push(`Last reported by the agent: ${event.event.text.trim()}`)
        break
      }
      if (event.event.kind === 'result' && event.event.summary?.trim()) {
        lines.push(`Reported by the agent: ${event.event.summary.trim()}`)
        break
      }
    }
    const status = await this.exec(['git', 'status', '--porcelain'], { cwd })
    const dirty = status.stdout.trim()
    lines.push(
      dirty === ''
        ? 'No uncommitted changes in the worktree.'
        : `Files changed in the worktree:\n${dirty}`,
    )
    return lines.join('\n\n')
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
    let runOpts = opts

    for (let attempt = 1; ; attempt++) {
      const run = await this.runAgent(taskId, sessionId, runOpts, phase, budget)
      this.throwIfCancelled(taskId)
      sessionId = run.sessionId
      summary = run.summary
      model = run.model
      effort = run.effort
      if (run.contextExceeded) {
        // Checked before ok: a hard kill must stop the run even when the
        // process happens to report a clean exit.
        if (this.contextRestarts >= config.loop.contextMaxRestarts) {
          this.transition(
            taskId,
            'needs_human',
            `context budget exceeded after ${this.contextRestarts} restart${this.contextRestarts === 1 ? '' : 's'}: peak ${this.peakContext} input tokens (limit ${this.contextLimits().maxTokens})`,
          )
          return { sessionId, stopped: true, summary, model, effort }
        }
        // Fresh-context restart: keep the worktree and claim, and hand the new
        // session a synthesized handoff of what the killed one did so the
        // work already in the worktree is not redone.
        this.contextRestarts++
        const handoff = await this.handoffSummary(taskId, runOpts.cwd)
        store.append(taskId, {
          type: 'run.restarted',
          phase,
          restart: this.contextRestarts,
          contextTokens: this.peakContext,
          summary: handoff,
        })
        sessionId = null
        this.peakContext = 0
        this.contextWarned = false
        runOpts = { ...runOpts, prompt: withRestartHandoff(opts.prompt, handoff) }
        this.transition(taskId, 'implementing')
        continue
      }
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

  private checkCommands(): string[] {
    const { format, lint, commands } = this.deps.config.checks
    // The mandatory gate always runs before the configured commands, so a PR
    // cannot be pushed until the worktree is formatted and lint-clean.
    const gate = [format, lint].filter((c): c is string => c !== null && c !== '')
    return [...gate, ...commands]
  }

  private async runChecks(cwd: string): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    for (const command of this.checkCommands()) {
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
    await this.stageAndCommit(task, cwd)

    // A clean worktree may still hold the agent's own commit from the session;
    // HEAD ahead of the base is work worth a PR, not the no_changes case.
    const ref = await diffBase(this.exec, cwd, base)
    const ahead = await this.exec(['git', 'rev-list', '--count', `${ref}..HEAD`], { cwd })
    if (ahead.exitCode !== 0 || Number(ahead.stdout.trim()) === 0) return false

    const sha = (await this.exec(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
    this.deps.store.append(task.id, {
      type: 'commit.created',
      sha,
      subject: `[${task.id}] ${task.title}`,
    })
    return true
  }

  /**
   * Stages and commits the worktree with the same message format as the
   * end-of-phase commit. `committed: false` means the worktree was already
   * clean; a git failure throws, since the caller decides how to surface it.
   */
  private async stageAndCommit(
    task: Pick<TrackerTask, 'id' | 'title'>,
    cwd: string,
  ): Promise<{ committed: false } | { committed: true; sha: string }> {
    const status = await this.exec(['git', 'status', '--porcelain'], { cwd })
    if (status.stdout.trim() === '') return { committed: false }
    await this.exec(['git', 'add', '-A'], { cwd })
    const changes = await changesSinceBase(this.exec, cwd, this.deps.config.repo.baseBranch, true)
    const message = commitMessage(task, changes)
    const commit = await this.exec(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
    }
    const sha = (await this.exec(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
    return { committed: true, sha }
  }

  /**
   * The one sanctioned git write an agent can cause, over the server channel:
   * stages and commits the worktree, records `commit.created`, and returns
   * the sha. A clean worktree or a git failure is returned as an error so the
   * agent learns immediately. No state transition, so it is usable any number
   * of times within a run.
   */
  async requestCommit(
    taskId: string,
    cwd: string,
  ): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
    const task = this.deps.store.task(taskId)
    if (task === null) return { ok: false, error: `unknown task ${taskId}` }
    try {
      const staged = await this.stageAndCommit(task, cwd)
      if (!staged.committed) return { ok: false, error: 'nothing to commit; the worktree is clean' }
      this.deps.store.append(taskId, {
        type: 'commit.created',
        sha: staged.sha,
        subject: `[${task.id}] ${task.title}`,
      })
      return { ok: true, sha: staged.sha }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  }

  /**
   * Consumes the git shim's rejected-call log for this task into `git.blocked`
   * events and clears the file. Best effort per line, so one malformed entry
   * cannot stop the rest; a missing file is just no blocked calls.
   */
  async drainGitBlocked(taskId: string): Promise<void> {
    const path = rejectedGitLogPath(taskId)
    let lines: string[]
    try {
      lines = readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
    } catch {
      return
    }
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { argv?: unknown }
        const argv = Array.isArray(parsed.argv)
          ? parsed.argv.filter((a): a is string => typeof a === 'string')
          : []
        if (argv.length === 0) continue
        this.deps.store.append(taskId, { type: 'git.blocked', argv })
      } catch {
        // Best effort: a malformed line is skipped, never fatal.
      }
    }
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort: a stale file is harmless.
    }
  }
}
