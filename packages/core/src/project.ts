import {
  type CheckResult,
  canTransition,
  type MergeStatus,
  type StoredEvent,
  type TaskState,
} from './events.ts'

export class InvalidTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`task ${taskId}: illegal transition ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

/**
 * One task as the shared projection sees it, whatever the source: the server
 * mirrors this into SQL (store.apply diffs it) and the clients fold events
 * into it directly (view.reduceState). Both are the same shape so a rebuild
 * reproduces what the clients render.
 */
export type ProjectedTask = {
  id: string
  title: string
  tracker: string
  state: TaskState
  branch: string | null
  worktree: string | null
  sessionId: string | null
  prUrl: string | null
  prNumber: number | null
  /** Merge status of the task's open PR, set by the pr poller while the PR is open. */
  prMergeStatus: MergeStatus | null
  statusReason: string | null
  lastError: string | null
  retryCount: number
  /** Epoch ms when the current deferred automatic retry fires; null when none is scheduled. */
  retryAt: number | null
  lastCommit: { sha: string; subject: string } | null
  checks: CheckResult[] | null
  checksOk: boolean | null
  /** 1-based; bumped by each operator reset, which wipes the run fields. */
  attempt: number
  /** Start of the current attempt: the first claim, or the latest reset. */
  createdAt: number
  updatedAt: number
}

export type ProjectedQuestion = {
  id: string
  taskId: string
  question: string
  options: string[]
  gateRef: string | null
  answer: string | null
  answeredVia: string | null
  askedAt: number
  resolvedAt: number | null
}

export type Projection = {
  tasks: Record<string, ProjectedTask>
  questions: Record<string, ProjectedQuestion>
}

export const emptyProjection = (): Projection => ({ tasks: {}, questions: {} })

/**
 * The single state machine. Folds one event over a projection; the server and
 * every client run exactly this, so a projection rebuilt from the event log is
 * identical everywhere. The event log is the source of truth; `project` only
 * interprets it, never mutates it.
 */
export function project(state: Projection, event: StoredEvent): Projection {
  if (event.taskId === null) return state
  const tasks = { ...state.tasks }
  const questions = { ...state.questions }
  const current = tasks[event.taskId]

  switch (event.type) {
    case 'task.claimed':
      tasks[event.taskId] = current
        ? {
            ...current,
            title: event.title,
            tracker: event.tracker,
            state: 'claimed',
            retryCount: 0,
            statusReason: null,
            updatedAt: event.ts,
          }
        : {
            id: event.taskId,
            title: event.title,
            tracker: event.tracker,
            state: 'claimed',
            branch: null,
            worktree: null,
            sessionId: null,
            prUrl: null,
            prNumber: null,
            prMergeStatus: null,
            statusReason: null,
            lastError: null,
            retryCount: 0,
            retryAt: null,
            lastCommit: null,
            checks: null,
            checksOk: null,
            attempt: 1,
            createdAt: event.ts,
            updatedAt: event.ts,
          }
      break

    case 'task.reset':
      if (current) {
        tasks[event.taskId] = {
          ...current,
          state: 'claimed',
          branch: null,
          worktree: null,
          sessionId: null,
          prUrl: null,
          prNumber: null,
          prMergeStatus: null,
          statusReason: event.reason ?? null,
          lastError: null,
          retryCount: 0,
          retryAt: null,
          lastCommit: null,
          checks: null,
          checksOk: null,
          attempt: current.attempt + 1,
          createdAt: event.ts,
          updatedAt: event.ts,
        }
        for (const q of Object.values(questions)) {
          if (q.taskId === event.taskId && q.resolvedAt === null) {
            questions[q.id] = { ...q, resolvedAt: event.ts }
          }
        }
      }
      break

    case 'task.state':
      if (current) {
        if (!canTransition(current.state, event.to)) {
          throw new InvalidTransitionError(event.taskId, current.state, event.to)
        }
        tasks[event.taskId] = {
          ...current,
          state: event.to,
          statusReason: event.reason ?? null,
          updatedAt: event.ts,
        }
      }
      break

    case 'task.reclaimed':
      if (current) {
        tasks[event.taskId] = {
          ...current,
          state: 'claimed',
          statusReason: event.reason ?? null,
          updatedAt: event.ts,
        }
      }
      break

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
        tasks[event.taskId] = { ...current, worktree: null, branch: null, updatedAt: event.ts }
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

    case 'pr.status':
      if (current) {
        tasks[event.taskId] = { ...current, prMergeStatus: event.mergeStatus, updatedAt: event.ts }
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

    case 'retry.scheduled':
      if (current) {
        tasks[event.taskId] = {
          ...current,
          retryCount: current.retryCount + 1,
          retryAt: event.ts + event.delayMs,
          updatedAt: event.ts,
        }
      }
      break

    case 'error':
      if (current) {
        tasks[event.taskId] = { ...current, lastError: event.message, updatedAt: event.ts }
      }
      break

    case 'question.asked':
      questions[event.questionId] = {
        id: event.questionId,
        taskId: event.taskId,
        question: event.question,
        options: event.options,
        gateRef: event.gateRef,
        answer: null,
        answeredVia: null,
        askedAt: event.ts,
        resolvedAt: null,
      }
      break

    case 'question.answered':
      {
        const q = questions[event.questionId]
        if (q) {
          questions[event.questionId] = {
            ...q,
            answer: event.answer,
            answeredVia: event.via,
            resolvedAt: event.ts,
          }
        }
      }
      break

    case 'question.timedout':
      {
        const q = questions[event.questionId]
        if (q) questions[event.questionId] = { ...q, resolvedAt: event.ts }
      }
      break

    default:
      break
  }

  return { tasks, questions }
}
