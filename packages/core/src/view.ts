import {
  type AgentRole,
  currentAttemptEvents,
  type Finding,
  isTerminal,
  type ReviewStopReason,
  type StoredEvent,
  type TaskState,
} from './events.ts'
import {
  emptyProjection,
  type ProjectedQuestion,
  type ProjectedTask,
  type ProjectedWatcherRun,
  type Projection,
  project,
} from './project.ts'

export type { ProjectedQuestion, ProjectedTask, Projection }
export { emptyProjection, project }

/**
 * The dashboard and TUI fold the event stream through the same pure reducer
 * the server uses to keep its SQL projection (`project` in project.ts), so a
 * client renders exactly what the API would answer, from events alone.
 */
export type DashboardState = Projection & {
  events: StoredEvent[]
  /** `events` split per task, in seq order, so per-task selectors skip the global log. */
  byTask: Record<string, StoredEvent[]>
  latestSeq: number
}

export const initialDashboardState = (): DashboardState => ({
  ...emptyProjection(),
  events: [],
  byTask: {},
  latestSeq: 0,
})

/**
 * Folds a batch of events in one pass: the log and each touched task's slice
 * are copied once per batch rather than once per event, which keeps a full
 * replay linear.
 */
export function reduceBatch(state: DashboardState, batch: readonly StoredEvent[]): DashboardState {
  const last = batch.at(-1)
  if (last === undefined) return state
  let projection: Projection = state
  const byTask = { ...state.byTask }
  const grown = new Set<string>()
  for (const event of batch) {
    projection = project(projection, event)
    if (event.taskId === null) continue
    if (!grown.has(event.taskId)) {
      byTask[event.taskId] = [...(byTask[event.taskId] ?? [])]
      grown.add(event.taskId)
    }
    byTask[event.taskId]?.push(event)
  }
  return {
    tasks: projection.tasks,
    questions: projection.questions,
    watcherRuns: projection.watcherRuns,
    events: state.events.concat(batch),
    byTask,
    latestSeq: last.seq,
  }
}

export function reduceState(state: DashboardState, event: StoredEvent): DashboardState {
  return reduceBatch(state, [event])
}

/** The task's events in seq order. */
export function taskEvents(state: DashboardState, taskId: string): StoredEvent[] {
  return state.byTask[taskId] ?? []
}

/**
 * The dashboard state as it stood at the end of one attempt of a task: the
 * task's events are cut at the reset that started the next attempt and
 * re-projected, so every per-task view renders that attempt unchanged.
 * Other tasks keep their full history.
 */
export function stateAtAttempt(
  state: DashboardState,
  taskId: string,
  attempt: number,
): DashboardState {
  let seen = 1
  const events = state.events.filter((e) => {
    if (e.taskId !== taskId) return true
    if (e.type === 'task.reset') seen++
    return seen <= attempt
  })
  return { ...reduceBatch(initialDashboardState(), events), latestSeq: state.latestSeq }
}

/** Tasks currently owned by a run, most recently touched first. */
export function activeTasks(state: DashboardState): ProjectedTask[] {
  return Object.values(state.tasks)
    .filter((t) => t.state !== 'queued' && !isTerminal(t.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function tasksNeedingAttention(state: DashboardState): ProjectedTask[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === 'needs_human' || t.state === 'no_pr' || t.state === 'pr_flagged')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function openQuestionsFor(state: DashboardState, taskId: string): ProjectedQuestion[] {
  return Object.values(state.questions)
    .filter((q) => q.taskId === taskId && q.resolvedAt === null)
    .sort((a, b) => a.askedAt - b.askedAt)
}

/** Completed and in-flight watcher runs, newest first. */
export function watcherRunsFor(
  state: DashboardState,
  repo: string,
  name: string,
  limit = Number.MAX_SAFE_INTEGER,
): ProjectedWatcherRun[] {
  return Object.values(state.watcherRuns)
    .filter((run) => run.repo === repo && run.name === name)
    .sort((a, b) => b.startSeq - a.startSeq)
    .slice(0, limit)
}

export function currentAgentFor(
  state: DashboardState,
  taskId: string,
): Extract<StoredEvent, { type: 'agent.started' }> | null {
  const events = taskEvents(state, taskId)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    // A chat run is not the implementing agent; skip it so the task detail
    // keeps naming the agent that actually did the work.
    if (event?.taskId === taskId && event.type === 'agent.started' && event.role !== 'chat') {
      return event
    }
  }
  return null
}

export type ReviewFindingOutcome = 'fixed' | 'disputed' | 'withdrawn' | 'unresolved'

export type ReviewRound = {
  round: number
  finalPass: boolean
  completed: boolean
  findings: (Finding & {
    outcome: ReviewFindingOutcome
    outcomeReason: string | null
    proposal: { issueId: string; title: string; url: string | null } | null
  })[]
  failed: string | null
}

export type ReviewHistory = { rounds: ReviewRound[]; stopReason: ReviewStopReason | null }

/** Review details the compact task projection does not retain. */
export function reviewHistoryFor(state: DashboardState, taskId: string): ReviewHistory {
  const rounds = new Map<number, ReviewRound>()
  const replies = new Map<number, Map<string, { outcome: 'fixed' | 'disputed'; reason: string }>>()
  const proposals = new Map<string, { issueId: string; title: string; url: string | null }>()
  let stopReason: ReviewStopReason | null = null
  for (const event of currentAttemptEvents(taskEvents(state, taskId), taskId)) {
    if (event.type === 'review.started') {
      rounds.set(event.round, {
        round: event.round,
        finalPass: event.finalPass,
        completed: false,
        findings: [],
        failed: null,
      })
      stopReason = null
    } else if (event.type === 'review.finished') {
      const round = rounds.get(event.round)
      if (round) {
        round.completed = true
        round.findings = event.findings.map((finding) => ({
          ...finding,
          outcome: 'unresolved',
          outcomeReason: null,
          proposal: null,
        }))
      }
    } else if (event.type === 'review.failed') {
      const round = rounds.get(event.round)
      if (round) {
        round.failed = event.reason
        round.completed = true
      }
    } else if (event.type === 'review.fixed') {
      replies.set(
        event.round,
        new Map(
          event.replies.map((reply) => [
            reply.id,
            { outcome: reply.outcome === 'fixed' ? 'fixed' : 'disputed', reason: reply.reason },
          ]),
        ),
      )
    } else if (event.type === 'review.stopped') {
      stopReason = event.reason
      const latest = [...rounds.values()].at(-1)
      if (latest) {
        for (const finding of latest.findings) {
          if (event.unresolvedIds.includes(finding.id)) finding.outcome = 'unresolved'
        }
      }
    } else if (event.type === 'review.proposal-filed') {
      proposals.set(event.findingId, { issueId: event.issueId, title: event.title, url: event.url })
    }
  }
  const ordered = [...rounds.values()].sort((a, b) => a.round - b.round)
  for (let i = 0; i < ordered.length; i++) {
    const round = ordered[i]
    if (!round) continue
    const nextIds = new Set(ordered[i + 1]?.findings.map((finding) => finding.id) ?? [])
    const roundReplies = replies.get(round.round)
    for (const finding of round.findings) {
      finding.proposal = proposals.get(finding.id) ?? null
      const reply = roundReplies?.get(finding.id)
      if (reply !== undefined) {
        finding.outcome = reply.outcome
        finding.outcomeReason = reply.reason
      } else if (ordered[i + 1]?.completed && !nextIds.has(finding.id))
        finding.outcome = 'withdrawn'
    }
  }
  return { rounds: ordered, stopReason }
}

/** Seat name when a review agent is queued for its credential. */
export function reviewWaitingSeat(state: DashboardState, taskId: string): string | null {
  return reviewWaitingSeatForEvents(taskEvents(state, taskId), taskId)
}

export function reviewWaitingSeatForEvents(events: StoredEvent[], taskId: string): string | null {
  let waiting: string | null = null
  for (const event of currentAttemptEvents(events, taskId)) {
    if (event.type === 'agent.stream' && event.role === 'review' && event.event.kind === 'status') {
      const match = /^waiting for seat (.+)$/.exec(event.event.message)
      if (match) waiting = match[1] ?? null
    } else if (event.type === 'agent.started' && event.role === 'review') {
      waiting = null
    } else if (event.type === 'agent.exited' && event.role === 'review') {
      waiting = null
    }
  }
  return waiting
}

/** Context size of the agent currently running on the task, if any usage has been reported. */
export function currentUsageFor(
  state: DashboardState,
  taskId: string,
): { inputTokens: number; outputTokens: number; cachedTokens: number } | null {
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  const events = taskEvents(state, taskId)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    // Stop at the current implementing run; earlier runs are another context.
    // Chat runs are not the implementing agent, so their usage is skipped like
    // currentAgentFor skips their starts.
    if (event.type === 'agent.started' && event.role !== 'chat') break
    if (event.type === 'agent.stream' && event.event.kind === 'usage' && event.role !== 'chat') {
      inputTokens += event.event.inputTokens
      outputTokens += event.event.outputTokens
      cachedTokens += event.event.cachedTokens ?? 0
    }
  }
  if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0) return null
  return { inputTokens, outputTokens, cachedTokens }
}

/** One message in the operator/worker chat: a user message or an assistant turn. */
export type ChatTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  ts: number
  /** The assistant turn is still streaming in (no agent.exited yet). */
  pending: boolean
}

/**
 * Folds the event log into a conversation: chat.message events are the
 * operator's side, and the text chunks of each 'chat'-role agent run fold into
 * one assistant turn. A chat run still in flight comes back as a pending turn
 * so the UI can show the worker typing as its text streams in.
 */
export function chatTurns(state: DashboardState, taskId: string): ChatTurn[] {
  const turns: ChatTurn[] = []
  let open: { text: string; seq: number; ts: number } | null = null
  const flush = (pending = false) => {
    if (open === null) return
    turns.push({
      id: `a${open.seq}`,
      role: 'assistant',
      text: open.text,
      ts: open.ts,
      pending,
    })
    open = null
  }
  for (const event of taskEvents(state, taskId)) {
    if (event.type === 'chat.message') {
      flush()
      turns.push({
        id: `u${event.seq}`,
        role: 'user',
        text: event.text,
        ts: event.ts,
        pending: false,
      })
    } else if (event.type === 'agent.started' && event.role === 'chat') {
      flush()
      open = { text: '', seq: event.seq, ts: event.ts }
    } else if (
      event.type === 'agent.stream' &&
      event.role === 'chat' &&
      event.event.kind === 'text' &&
      open !== null
    ) {
      open.text += event.event.text
    } else if (event.type === 'agent.exited' && event.role === 'chat') {
      flush()
    }
  }
  flush(true)
  return turns
}

/** Whether a chat run is currently in flight for the task (worker responding). */
export function chatInFlight(state: DashboardState, taskId: string): boolean {
  let started = false
  for (const event of taskEvents(state, taskId)) {
    if (event.type === 'agent.started' && event.role === 'chat') started = true
    else if (event.type === 'agent.exited' && event.role === 'chat') started = false
  }
  return started
}

/** One state the task entered during an attempt, and how it got there. */
export type StatusEntry = {
  seq: number
  ts: number
  /** What moved the task: its claim, a transition, an operator reset or a reclaim. */
  cause: 'claimed' | 'state' | 'reset' | 'reclaimed'
  from: TaskState | null
  to: TaskState
  reason: string | null
  /** Time spent in `to`: until the next entry, else until `now` while in flight, else null. */
  durationMs: number | null
  /** The repo's setupCmd, run while the task was in this state. */
  setup: StatusSetup | null
  runs: StatusRun[]
}

export type StatusSetup = {
  command: string
  startedAt: number
  /** Until it finished, else until `now` while in flight, else null. */
  durationMs: number | null
  exitCode: number | null
}

export type StatusRun = {
  role: AgentRole
  harness: string
  model: string | null
  effort: string | null
  resumed: boolean
  startedAt: number
  durationMs: number | null
  exitCode: number | null
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  restart: number | null
  label: string
}

/**
 * The status history of the task's current attempt, oldest first. Pass a null
 * `now` for a settled view (a past attempt), so the last state gets no
 * open-ended duration.
 */
export function statusLog(
  state: DashboardState,
  taskId: string,
  now: number | null = Date.now(),
): StatusEntry[] {
  const entries: StatusEntry[] = []
  let current: TaskState | null = null
  const push = (
    event: StoredEvent,
    cause: StatusEntry['cause'],
    to: TaskState,
    reason?: string,
  ) => {
    entries.push({
      seq: event.seq,
      ts: event.ts,
      cause,
      from: current,
      to,
      reason: reason ?? null,
      durationMs: null,
      setup: null,
      runs: [],
    })
    current = to
  }
  const events = currentAttemptEvents(taskEvents(state, taskId), taskId)
  let activeRun: StatusRun | null = null
  let activeSetup: StatusSetup | null = null
  let pendingRestart: number | null = null
  let checksSinceImplement = false
  for (const event of events) {
    switch (event.type) {
      case 'task.claimed':
        push(event, 'claimed', 'claimed')
        break
      case 'task.state':
        push(event, 'state', event.to, event.reason)
        break
      case 'task.reset':
        push(event, 'reset', 'claimed', event.reason)
        break
      case 'task.reclaimed':
        push(event, 'reclaimed', 'queued', event.reason)
        break
      case 'run.restarted':
        pendingRestart = event.restart
        break
      case 'setup.started': {
        activeSetup = {
          command: event.command,
          startedAt: event.ts,
          durationMs: null,
          exitCode: null,
        }
        const entry = entries.at(-1)
        if (entry !== undefined) entry.setup = activeSetup
        break
      }
      case 'setup.finished':
        if (activeSetup !== null) {
          activeSetup.durationMs = event.durationMs
          activeSetup.exitCode = event.exitCode
          activeSetup = null
        }
        break
      case 'agent.started': {
        const label = [
          event.role,
          ...(event.role === 'implement' && checksSinceImplement ? ['(fix)'] : []),
          ...(event.role === 'implement' && event.resumed ? ['(resumed)'] : []),
          ...(pendingRestart === null ? [] : [`(restart ${pendingRestart})`]),
        ].join(' ')
        activeRun = {
          role: event.role,
          harness: event.harness,
          model: event.model,
          effort: event.effort,
          resumed: event.resumed,
          startedAt: event.ts,
          durationMs: null,
          exitCode: null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          restart: pendingRestart,
          label,
        }
        entries.at(-1)?.runs.push(activeRun)
        if (event.role === 'implement') checksSinceImplement = false
        pendingRestart = null
        break
      }
      case 'agent.stream':
        if (activeRun !== null && activeRun.role === event.role && event.event.kind === 'usage') {
          activeRun.inputTokens += event.event.inputTokens
          activeRun.outputTokens += event.event.outputTokens
          if (event.event.costUsd !== undefined) {
            activeRun.costUsd = (activeRun.costUsd ?? 0) + event.event.costUsd
          }
        }
        break
      case 'agent.exited':
        if (activeRun !== null && activeRun.role === event.role) {
          activeRun.durationMs = event.ts - activeRun.startedAt
          activeRun.exitCode = event.exitCode
          activeRun = null
        }
        break
      default:
        break
    }
    if (event.type === 'task.state' && event.to === 'checks') checksSinceImplement = true
  }
  for (const [i, entry] of entries.entries()) {
    const next = entries[i + 1]
    if (next !== undefined) entry.durationMs = next.ts - entry.ts
    else if (now !== null && !isTerminal(entry.to)) entry.durationMs = now - entry.ts
  }
  if (activeRun !== null) {
    activeRun.durationMs = now === null ? null : now - activeRun.startedAt
  }
  if (activeSetup !== null) {
    activeSetup.durationMs = now === null ? null : now - activeSetup.startedAt
  }
  return entries
}

/**
 * A task's run health as the guards see it: context against the soft/hard
 * limits, cost and elapsed against the task budgets, and every guard warning
 * already raised. Values come from the event stream alone, so the dashboard
 * and TUI render exactly what the runner enforced.
 */
export type RunHealth = {
  /** Peak input context (input + cached) of the current run, from the last run.context event. */
  contextTokens: number | null
  /** Effective soft context limit for the active harness, from run.limits. */
  contextWarnTokens: number | null
  /** Effective hard context limit for the active harness, from run.limits. */
  contextMaxTokens: number | null
  /** Accumulated implement usage cost in USD; 0 when the harness reports no cost. */
  costUsd: number
  /** Whether any implement usage event carried a dollar figure. */
  costSeen: boolean
  /** Max cost budget in USD; 0 means unbounded. */
  maxCostUsd: number
  /** Wall-clock since first claim, in ms. */
  elapsedMs: number
  /** Max run time budget in ms; 0 or null means unbounded. */
  maxRunMs: number | null
  /** Guard warnings already raised: doom-loop detections and context crossings. */
  warnings: string[]
}

/** Folds a task's run health out of the event stream. `now` is injectable for tests. */
export function runHealth(state: DashboardState, taskId: string, now = Date.now()): RunHealth {
  const task = state.tasks[taskId]
  let contextTokens: number | null = null
  let contextWarnTokens: number | null = null
  let contextMaxTokens: number | null = null
  let maxRunMs: number | null = null
  let maxCostUsd = 0
  let costUsd = 0
  let costSeen = false
  const warnings: string[] = []
  for (const event of currentAttemptEvents(taskEvents(state, taskId), taskId)) {
    switch (event.type) {
      case 'run.context':
        contextTokens = event.contextTokens
        break
      case 'run.limits':
        contextWarnTokens = event.contextWarnTokens
        contextMaxTokens = event.contextMaxTokens
        maxRunMs = event.maxRunMs === 0 ? null : event.maxRunMs
        maxCostUsd = event.maxCostUsd
        break
      case 'agent.stream':
        // Chat runs are not the implementing agent, so their usage is outside
        // the task budgets, matching how the runner accumulates cost.
        if (event.event.kind !== 'usage' || event.role === 'chat') break
        if (event.event.costUsd !== undefined) {
          costUsd += event.event.costUsd
          costSeen = true
        }
        break
      case 'doom.detected':
        warnings.push(`doom loop: ${event.detail}`)
        break
      case 'context.warn':
        warnings.push(`context warning: ${event.contextTokens}/${event.limit} tokens`)
        break
      case 'context.exceeded':
        warnings.push(`context exceeded: ${event.contextTokens}/${event.limit} tokens`)
        break
      default:
        break
    }
  }
  return {
    contextTokens,
    contextWarnTokens,
    contextMaxTokens,
    costUsd,
    costSeen,
    maxCostUsd,
    elapsedMs: task === undefined ? 0 : now - task.createdAt,
    maxRunMs,
    warnings,
  }
}

/**
 * Whether a run is nearing a guard limit: a warning already raised, context at
 * or past the soft limit, or elapsed/cost at 80% of the configured budget. The
 * compact marker the workers panels use.
 */
export function runHealthNearLimit(health: RunHealth): boolean {
  if (health.warnings.length > 0) return true
  if (
    health.contextTokens !== null &&
    health.contextWarnTokens !== null &&
    health.contextTokens >= health.contextWarnTokens
  ) {
    return true
  }
  if (
    health.maxRunMs !== null &&
    health.maxRunMs > 0 &&
    health.elapsedMs / health.maxRunMs >= 0.8
  ) {
    return true
  }
  if (health.costSeen && health.maxCostUsd > 0 && health.costUsd / health.maxCostUsd >= 0.8) {
    return true
  }
  return false
}

/** One harness + model + effort configuration's track record over finished tasks. */
export type ScorecardRow = {
  harness: string
  model: string | null
  effort: string | null
  /** Fleet workers that ran this configuration, sorted; ad-hoc runs add none. */
  workers: string[]
  finished: number
  /** Tasks whose PR merged. */
  merged: number
  /** PR closed unmerged, or the task was closed by hand. */
  abandoned: number
  /** Finished with no PR: no changes, or marked done because the work was already there. */
  noPr: number
  needsHuman: number
  /** Agent cost of every finished task in the row, all roles but chat. */
  costUsd: number
  /** Whether any of that usage carried a dollar figure. */
  costSeen: boolean
  /** Median wall-clock from attempt start to merge; null when nothing merged. */
  medianMergeMs: number | null
  /** Mean review rounds per finished task. */
  avgReviewRounds: number
}

/**
 * Outcome per harness + model + effort, from each finished task's current
 * attempt, attributed to the attempt's first implement agent. Cancelled tasks
 * are left out: stopping a run is the operator's call, not the agent's
 * failure. `since` keeps tasks that finished at or after that epoch ms.
 */
export function scorecard(state: DashboardState, since = 0): ScorecardRow[] {
  const rows = new Map<string, ScorecardRow & { mergeMs: number[]; reviewRounds: number }>()
  for (const task of Object.values(state.tasks)) {
    if (
      task.state !== 'done' &&
      task.state !== 'abandoned' &&
      task.state !== 'no_pr' &&
      task.state !== 'needs_human'
    ) {
      continue
    }
    let agent: Extract<StoredEvent, { type: 'agent.started' }> | null = null
    let finishedAt = task.updatedAt
    let costUsd = 0
    let costSeen = false
    for (const event of currentAttemptEvents(taskEvents(state, task.id), task.id)) {
      if (event.type === 'agent.started' && event.role === 'implement' && agent === null) {
        agent = event
      } else if (event.type === 'task.state' && event.to === task.state) {
        finishedAt = event.ts
      } else if (
        event.type === 'agent.stream' &&
        event.role !== 'chat' &&
        event.event.kind === 'usage' &&
        event.event.costUsd !== undefined
      ) {
        costUsd += event.event.costUsd
        costSeen = true
      }
    }
    if (agent === null || finishedAt < since) continue
    const key = JSON.stringify([agent.harness, agent.model, agent.effort])
    let row = rows.get(key)
    if (row === undefined) {
      row = {
        harness: agent.harness,
        model: agent.model,
        effort: agent.effort,
        workers: [],
        finished: 0,
        merged: 0,
        abandoned: 0,
        noPr: 0,
        needsHuman: 0,
        costUsd: 0,
        costSeen: false,
        medianMergeMs: null,
        avgReviewRounds: 0,
        mergeMs: [],
        reviewRounds: 0,
      }
      rows.set(key, row)
    }
    if (agent.worker !== undefined && !row.workers.includes(agent.worker)) {
      row.workers.push(agent.worker)
    }
    row.finished++
    row.costUsd += costUsd
    row.costSeen ||= costSeen
    row.reviewRounds += task.reviewRound
    if (task.state === 'done' && task.prNumber !== null) {
      row.merged++
      row.mergeMs.push(finishedAt - task.createdAt)
    } else if (task.state === 'done' || task.state === 'no_pr') {
      row.noPr++
    } else if (task.state === 'abandoned') {
      row.abandoned++
    } else {
      row.needsHuman++
    }
  }
  return [...rows.values()]
    .map(({ mergeMs, reviewRounds, ...row }) => ({
      ...row,
      workers: row.workers.sort(),
      medianMergeMs: median(mergeMs),
      avgReviewRounds: reviewRounds / row.finished,
    }))
    .sort((a, b) => b.finished - a.finished)
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}
