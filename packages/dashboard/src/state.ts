import { type CheckResult, isTerminal, type StoredEvent, type TaskState } from '@amagi/core/events'

export type TaskView = {
  id: string
  title: string
  tracker: string
  state: TaskState
  branch: string | null
  worktree: string | null
  sessionId: string | null
  prUrl: string | null
  prNumber: number | null
  reviewRound: number
  lastError: string | null
  lastCommit: { sha: string; subject: string } | null
  checks: CheckResult[] | null
  checksOk: boolean | null
  createdAt: number
  updatedAt: number
}

export type QuestionView = {
  id: string
  taskId: string
  question: string
  options: string[]
  answer: string | null
  askedAt: number
  resolvedAt: number | null
}

export type DashboardState = {
  tasks: Record<string, TaskView>
  questions: Record<string, QuestionView>
  events: StoredEvent[]
  latestSeq: number
}

export const initialDashboardState = (): DashboardState => ({
  tasks: {},
  questions: {},
  events: [],
  latestSeq: 0,
})

/**
 * The wire contract from @amagi/core is the single source of truth; the
 * server-side `store.apply` projection is mirrored here so the dashboard
 * renders exactly what the API would answer, from events alone.
 */
export function reduceState(state: DashboardState, event: StoredEvent): DashboardState {
  const tasks = { ...state.tasks }
  const questions = { ...state.questions }
  const task = (id: string) => tasks[id]

  if (event.taskId !== null) {
    const current = task(event.taskId)
    switch (event.type) {
      case 'task.claimed': {
        if (current) {
          tasks[event.taskId] = {
            ...current,
            title: event.title,
            tracker: event.tracker,
            updatedAt: event.ts,
          }
        } else {
          tasks[event.taskId] = {
            id: event.taskId,
            title: event.title,
            tracker: event.tracker,
            state: 'claimed',
            branch: null,
            worktree: null,
            sessionId: null,
            prUrl: null,
            prNumber: null,
            reviewRound: 0,
            lastError: null,
            lastCommit: null,
            checks: null,
            checksOk: null,
            createdAt: event.ts,
            updatedAt: event.ts,
          }
        }
        break
      }
      case 'task.state': {
        if (current) {
          const reviewRound =
            event.to === 'reviewing' ? current.reviewRound + 1 : current.reviewRound
          tasks[event.taskId] = { ...current, state: event.to, reviewRound, updatedAt: event.ts }
        }
        break
      }
      case 'worktree.created':
        if (current) {
          tasks[event.taskId] = {
            ...current,
            worktree: event.path,
            branch: event.branch,
            updatedAt: event.ts,
          }
        }
        break
      case 'worktree.removed':
        if (current) {
          tasks[event.taskId] = {
            ...current,
            worktree: null,
            branch: null,
            updatedAt: event.ts,
          }
        }
        break
      case 'agent.exited':
        if (current && event.sessionId !== null) {
          tasks[event.taskId] = { ...current, sessionId: event.sessionId, updatedAt: event.ts }
        }
        break
      case 'commit.created':
        if (current) {
          tasks[event.taskId] = {
            ...current,
            lastCommit: { sha: event.sha, subject: event.subject },
            updatedAt: event.ts,
          }
        }
        break
      case 'pr.created':
        if (current) {
          tasks[event.taskId] = {
            ...current,
            prUrl: event.url,
            prNumber: event.number,
            updatedAt: event.ts,
          }
        }
        break
      case 'checks.finished':
        if (current) {
          tasks[event.taskId] = {
            ...current,
            checks: event.results,
            checksOk: event.ok,
            updatedAt: event.ts,
          }
        }
        break
      case 'question.asked':
        questions[event.questionId] = {
          id: event.questionId,
          taskId: event.taskId,
          question: event.question,
          options: event.options,
          answer: null,
          askedAt: event.ts,
          resolvedAt: null,
        }
        break
      case 'question.answered':
        if (questions[event.questionId]) {
          const q = questions[event.questionId]
          if (q) questions[event.questionId] = { ...q, answer: event.answer, resolvedAt: event.ts }
        }
        break
      case 'question.timedout':
        if (questions[event.questionId]) {
          const q = questions[event.questionId]
          if (q) questions[event.questionId] = { ...q, resolvedAt: event.ts }
        }
        break
      case 'error':
        if (current) {
          tasks[event.taskId] = { ...current, lastError: event.message, updatedAt: event.ts }
        }
        break
      default:
        break
    }
  }

  return { tasks, questions, events: [...state.events, event], latestSeq: event.seq }
}

/** The queue view: every task still in flight, most recently touched first. */
export function activeTasks(state: DashboardState): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => !isTerminal(t.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function tasksNeedingAttention(state: DashboardState): TaskView[] {
  return Object.values(state.tasks)
    .filter((t) => t.state === 'needs_human')
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
