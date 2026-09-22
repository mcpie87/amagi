import { isTerminal, type StoredEvent } from './events.ts'
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
export type TaskView = ProjectedTask
export type QuestionView = ProjectedQuestion

export type DashboardState = Projection & {
  events: StoredEvent[]
  latestSeq: number
}

export const initialDashboardState = (): DashboardState => ({
  ...emptyProjection(),
  events: [],
  latestSeq: 0,
})

export function reduceState(state: DashboardState, event: StoredEvent): DashboardState {
  return { ...project(state, event), events: [...state.events, event], latestSeq: event.seq }
}

/** The queue view: every task still in flight, most recently touched first. */
export function activeTasks(state: DashboardState): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => !isTerminal(t.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function tasksNeedingAttention(state: DashboardState): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === 'needs_human' || t.state === 'no_pr' || t.state === 'pr_flagged')
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function openQuestionsFor(state: DashboardState, taskId: string): QuestionView[] {
  return Object.values(state.questions)
    .filter((q) => q.taskId === taskId && q.resolvedAt === null)
    .sort((a, b) => a.askedAt - b.askedAt)
}

export function currentAgentFor(
  state: DashboardState,
  taskId: string,
): Extract<StoredEvent, { type: 'agent.started' }> | null {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i]
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
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i]
    if (event?.taskId !== taskId) continue
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
  for (const event of state.events) {
    if (event.taskId !== taskId) continue
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
  for (const event of state.events) {
    if (event.taskId !== taskId) continue
    if (event.type === 'agent.started' && event.role === 'chat') started = true
    else if (event.type === 'agent.exited' && event.role === 'chat') started = false
  }
  return started
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
  for (const event of state.events) {
    if (event.taskId !== taskId) continue
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
