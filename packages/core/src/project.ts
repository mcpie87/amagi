import {
  type CheckResult,
  canTransition,
  type Finding,
  type MergeStatus,
  type ReviewStopReason,
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
  /** Most recent review round, or zero before review begins in this attempt. */
  reviewRound: number
  /** Findings from the most recently completed review round. */
  reviewFindings: Finding[] | null
  /** Why the review loop stopped, if it has stopped. */
  reviewStopReason: ReviewStopReason | null
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

export type ProjectedWatcherAction = {
  targetType: 'pr' | 'mention' | 'task'
  targetId: string
  prNumber?: number
  url?: string
  result: string
  level: 'info' | 'error'
  ts: number
}

export type ProjectedWatcherLogEntry = { ts: number; message: string; level: 'info' | 'error' }

export type ProjectedWatcherRun = {
  repo: string
  name: string
  runId: string
  startedAt: number
  endedAt: number | null
  ok: boolean | null
  error: string | null
  actions: ProjectedWatcherAction[]
  log: ProjectedWatcherLogEntry[]
  startSeq: number
  endSeq: number | null
}

export const watcherRunKey = (repo: string, name: string, runId: string): string =>
  JSON.stringify([repo, name, runId])

export type Projection = {
  tasks: Record<string, ProjectedTask>
  questions: Record<string, ProjectedQuestion>
  watcherRuns: Record<string, ProjectedWatcherRun>
}

export const emptyProjection = (): Projection => ({ tasks: {}, questions: {}, watcherRuns: {} })

/**
 * The single state machine. Folds one event over a projection; the server and
 * every client run exactly this, so a projection rebuilt from the event log is
 * identical everywhere. The event log is the source of truth; `project` only
 * interprets it, never mutates it.
 */
export function project(state: Projection, event: StoredEvent): Projection {
  if (event.type === 'watcher.run.started') {
    const key = watcherRunKey(event.repo, event.name, event.runId)
    const watcherRuns = { ...state.watcherRuns }
    // A watcher's ticks are sequential, so a run still open when the next one
    // starts died with its process (a serve restart) and never finishes.
    for (const [k, run] of Object.entries(watcherRuns)) {
      if (run.repo !== event.repo || run.name !== event.name || run.endedAt !== null) continue
      const error = 'interrupted: the watcher restarted before this run finished'
      watcherRuns[k] = {
        ...run,
        endedAt: event.ts,
        ok: false,
        error,
        endSeq: event.seq,
        log: [...run.log, { ts: event.ts, message: `run ${error}`, level: 'error' }],
      }
    }
    watcherRuns[key] = {
      repo: event.repo,
      name: event.name,
      runId: event.runId,
      startedAt: event.ts,
      endedAt: null,
      ok: null,
      error: null,
      actions: [],
      log: [{ ts: event.ts, message: 'run started', level: 'info' }],
      startSeq: event.seq,
      endSeq: null,
    }
    return { ...state, watcherRuns }
  }
  if (event.type === 'watcher.action') {
    const key = watcherRunKey(event.repo, event.name, event.runId)
    const currentRun = state.watcherRuns[key]
    if (currentRun === undefined) return state
    const watcherRuns = { ...state.watcherRuns }
    const action: ProjectedWatcherAction = {
      targetType: event.targetType,
      targetId: event.targetId,
      ...(event.prNumber === undefined ? {} : { prNumber: event.prNumber }),
      ...(event.url === undefined ? {} : { url: event.url }),
      result: event.result,
      level: event.level,
      ts: event.ts,
    }
    watcherRuns[key] = {
      ...currentRun,
      actions: [...currentRun.actions, action],
      log: [
        ...currentRun.log,
        {
          ts: event.ts,
          message: `${event.targetType} ${event.targetId}: ${event.result}`,
          level: event.level,
        },
      ],
    }
    return { ...state, watcherRuns }
  }
  if (event.type === 'watcher.run.finished') {
    const key = watcherRunKey(event.repo, event.name, event.runId)
    const currentRun = state.watcherRuns[key]
    if (currentRun === undefined) return state
    const watcherRuns = { ...state.watcherRuns }
    const error = event.error ?? null
    watcherRuns[key] = {
      ...currentRun,
      endedAt: event.ts,
      ok: event.ok,
      error,
      endSeq: event.seq,
      log: [
        ...currentRun.log,
        {
          ts: event.ts,
          message: event.ok ? 'run completed' : `run failed${error === null ? '' : `: ${error}`}`,
          level: event.ok ? 'info' : 'error',
        },
      ],
    }
    return { ...state, watcherRuns }
  }
  if (event.taskId === null) return state
  // Copy-on-write: the clients fold tens of thousands of events, most of which
  // touch neither map, so copying both on every event made replay quadratic.
  let tasks = state.tasks
  let questions = state.questions
  const writeTasks = () => {
    if (tasks === state.tasks) tasks = { ...state.tasks }
    return tasks
  }
  const writeQuestions = () => {
    if (questions === state.questions) questions = { ...state.questions }
    return questions
  }
  const current = tasks[event.taskId]

  switch (event.type) {
    case 'task.claimed':
      writeTasks()[event.taskId] = current
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
            reviewRound: 0,
            reviewFindings: null,
            reviewStopReason: null,
            attempt: 1,
            createdAt: event.ts,
            updatedAt: event.ts,
          }
      break

    case 'task.reset':
      if (current) {
        writeTasks()[event.taskId] = {
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
          reviewRound: 0,
          reviewFindings: null,
          reviewStopReason: null,
          attempt: current.attempt + 1,
          createdAt: event.ts,
          updatedAt: event.ts,
        }
        for (const q of Object.values(questions)) {
          if (q.taskId === event.taskId && q.resolvedAt === null) {
            writeQuestions()[q.id] = { ...q, resolvedAt: event.ts }
          }
        }
      }
      break

    case 'task.state':
      if (current) {
        if (!canTransition(current.state, event.to)) {
          throw new InvalidTransitionError(event.taskId, current.state, event.to)
        }
        writeTasks()[event.taskId] = {
          ...current,
          state: event.to,
          statusReason: event.reason ?? null,
          updatedAt: event.ts,
        }
      }
      break

    case 'task.reclaimed':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          state: 'queued',
          statusReason: event.reason ?? null,
          updatedAt: event.ts,
        }
      }
      break

    case 'review.started':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          reviewRound: event.round,
          reviewStopReason: null,
          updatedAt: event.ts,
        }
      }
      break

    case 'review.finished':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          reviewRound: event.round,
          reviewFindings: event.findings,
          updatedAt: event.ts,
        }
      }
      break

    case 'review.stopped':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          reviewStopReason: event.reason,
          updatedAt: event.ts,
        }
      }
      break

    case 'worktree.created':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          worktree: event.path,
          branch: event.branch,
          updatedAt: event.ts,
        }
      }
      break

    case 'worktree.removed':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          worktree: null,
          branch: null,
          updatedAt: event.ts,
        }
      }
      break

    case 'agent.exited':
      if (current && event.sessionId !== null) {
        writeTasks()[event.taskId] = { ...current, sessionId: event.sessionId, updatedAt: event.ts }
      }
      break

    case 'commit.created':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          lastCommit: { sha: event.sha, subject: event.subject },
          updatedAt: event.ts,
        }
      }
      break

    case 'pr.created':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          prUrl: event.url,
          prNumber: event.number,
          updatedAt: event.ts,
        }
      }
      break

    case 'pr.status':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          prMergeStatus: event.mergeStatus,
          updatedAt: event.ts,
        }
      }
      break

    case 'checks.finished':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          checks: event.results,
          checksOk: event.ok,
          updatedAt: event.ts,
        }
      }
      break

    case 'retry.scheduled':
      if (current) {
        writeTasks()[event.taskId] = {
          ...current,
          retryCount: current.retryCount + 1,
          retryAt: event.ts + event.delayMs,
          updatedAt: event.ts,
        }
      }
      break

    case 'error':
      if (current) {
        writeTasks()[event.taskId] = { ...current, lastError: event.message, updatedAt: event.ts }
      }
      break

    case 'question.asked':
      writeQuestions()[event.questionId] = {
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
          writeQuestions()[event.questionId] = {
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
        if (q) writeQuestions()[event.questionId] = { ...q, resolvedAt: event.ts }
      }
      break

    default:
      break
  }

  return tasks === state.tasks && questions === state.questions
    ? state
    : { ...state, tasks, questions }
}
