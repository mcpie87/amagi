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
    .filter((t) => t.state === 'needs_human' || t.state === 'no_pr')
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
    if (event?.taskId === taskId && event.type === 'agent.started') return event
  }
  return null
}
