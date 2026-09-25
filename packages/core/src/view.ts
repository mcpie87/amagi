import {
  type AgentRole,
  currentAttemptEvents,
  isTerminal,
  type StoredEvent,
  type TaskState,
} from './events.ts'
import {
  emptyProjection,
  type ProjectedQuestion,
  type ProjectedTask,
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
  runs: StatusRun[]
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
      runs: [],
    })
    current = to
  }
  const events = currentAttemptEvents(taskEvents(state, taskId), taskId)
  let activeRun: StatusRun | null = null
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
