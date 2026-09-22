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
