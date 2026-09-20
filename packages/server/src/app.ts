import {
  type BeadsIssue,
  CAPABILITY_WORDS,
  isTerminal,
  type Notifier,
  type Question,
  type Store,
  type Tracker,
  type TrackerCapabilities,
  type TrackerTask,
  UnsupportedCapabilityError,
  type UpdateTrackerTask,
} from '@amagi/core'
import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import { Hono } from 'hono'
import * as z from 'zod'
import {
  AnswerBody,
  AskBody,
  AwaitQuery,
  EventQuery,
  IssueCreateBody,
  IssueIdParam,
  IssueUpdateBody,
  QuestionQuery,
  StreamQuery,
  TaskIdParam,
  TaskListQuery,
  TaskQuestionParam,
} from './schemas.ts'
import { eventStream } from './stream.ts'

export type ServerDeps = {
  store: Store
  notify?: Notifier[]
  /**
   * When present, questions open a blocking gate on the tracker issue so a
   * human answering outside amagi (e.g. `bd gate resolve`) can still unblock
   * the agent. Absent in tests that exercise the question channel alone.
   */
  tracker?: Tracker
  listIssues?: () => Promise<BeadsIssue[]>
  /** Rich issue detail, including dependency blockers, when the tracker has it. */
  getIssue?: (id: string) => Promise<BeadsIssue | null>
}

/**
 * Every failure on the API answers with the same `{ error }` shape, so the
 * hono/client response union stays one success type plus one error type.
 */
const valid = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: z.prettifyError(result.error) }, 400)
  })

/** The 501 reason for an operation the tracker cannot do, or null when it can. */
function capabilityError(tracker: Tracker, capability: keyof TrackerCapabilities): string | null {
  return tracker.capabilities[capability]
    ? null
    : `${tracker.kind} tracker does not support ${CAPABILITY_WORDS[capability]}`
}

/**
 * The agent carries AMAGI_TASK_TOKEN in its environment; a question is bound
 * to the task that spawned it, so one agent cannot answer for another.
 */
const authorized = (c: Context, store: Store, id: string): boolean =>
  c.req.header('X-Amagi-Token') === store.token(id)

/**
 * Best effort: a notifier (e.g. a missing notify-send) must never break the
 * ask request, so failures are logged and still recorded as notify.sent so
 * the dashboard shows what was attempted.
 */
async function notifyChannels(
  notifiers: Notifier[],
  store: Store,
  title: string,
  body: string,
): Promise<void> {
  for (const notifier of notifiers) {
    try {
      await notifier.notify(title, body)
    } catch (err) {
      console.warn(`notify ${notifier.kind}: ${err instanceof Error ? err.message : String(err)}`)
    }
    store.append(null, { type: 'notify.sent', channel: notifier.kind, title })
  }
}

/**
 * A gate is a courtesy, not a prerequisite: if the tracker cannot open one the
 * question still lands in the store and the notifiers still fire, so the agent
 * is never stranded by a tracker hiccup.
 */
async function openQuestionGate(
  tracker: Tracker | undefined,
  taskId: string,
  question: Question,
): Promise<string | null> {
  if (tracker === undefined) return null
  try {
    return (await tracker.openGate(taskId, question)).id
  } catch (err) {
    console.warn(`openGate ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function resolveQuestionGate(
  tracker: Tracker | undefined,
  gateRef: string | null,
): Promise<void> {
  if (tracker === undefined || gateRef === null) return
  try {
    await tracker.resolveGate({ id: gateRef, advisory: false })
  } catch (err) {
    console.warn(`resolveGate ${gateRef}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function createApp({ store, notify = [], tracker, listIssues, getIssue }: ServerDeps) {
  return new Hono()
    .get('/api/health', (c) => c.json({ ok: true }))

    .get('/api/issues', async (c) => {
      if (listIssues === undefined) return c.json({ error: 'issue browser is unavailable' }, 501)
      return c.json(await listIssues())
    })

    .get('/api/issues/:id', valid('param', IssueIdParam), async (c) => {
      const { id } = c.req.valid('param')
      if (getIssue === undefined) return c.json({ error: 'issue detail is unavailable' }, 501)
      const issue = await getIssue(id)
      if (issue === null) return c.json({ error: `unknown issue ${id}` }, 404)
      return c.json(issue)
    })

    .post('/api/issues', valid('json', IssueCreateBody), async (c) => {
      if (tracker === undefined) return c.json({ error: 'no tracker is configured' }, 501)
      const cap = capabilityError(tracker, 'create')
      if (cap !== null) return c.json({ error: cap }, 501)
      try {
        const created: TrackerTask = await tracker.createTask(c.req.valid('json'))
        const issue = getIssue === undefined ? null : await getIssue(created.id)
        return c.json(issue ?? created, 201)
      } catch (err) {
        if (err instanceof UnsupportedCapabilityError) return c.json({ error: err.message }, 501)
        throw err
      }
    })

    .patch(
      '/api/issues/:id',
      valid('param', IssueIdParam),
      valid('json', IssueUpdateBody),
      async (c) => {
        const { id } = c.req.valid('param')
        if (tracker === undefined) return c.json({ error: 'no tracker is configured' }, 501)
        const body = c.req.valid('json')
        const input: UpdateTrackerTask = {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: body.acceptanceCriteria }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.labels === undefined ? {} : { labels: body.labels }),
        }
        // Only the operation actually requested is gated, so a dependency-only
        // edit reports the dependency gap rather than a generic edit gap.
        if (Object.keys(input).length > 0) {
          const editCap = capabilityError(tracker, 'edit')
          if (editCap !== null) return c.json({ error: editCap }, 501)
        }
        // The board edits dependencies as a full set; the tracker wants a diff.
        if (body.dependencies !== undefined) {
          const depCap = capabilityError(tracker, 'dependencies')
          if (depCap !== null) return c.json({ error: depCap }, 501)
          if (getIssue === undefined) {
            return c.json({ error: 'cannot resolve dependency changes without issue detail' }, 501)
          }
          const current = (await getIssue(id))?.dependencies.map((d) => d.id) ?? []
          input.dependencies = {
            add: body.dependencies.filter((d) => !current.includes(d)),
            remove: current.filter((d) => !body.dependencies?.includes(d)),
          }
        }
        try {
          const updated = await tracker.updateTask(id, input)
          const issue = getIssue === undefined ? null : await getIssue(updated.id)
          return c.json(issue ?? updated)
        } catch (err) {
          if (err instanceof UnsupportedCapabilityError) {
            return c.json({ error: err.message }, 501)
          }
          throw err
        }
      },
    )

    .get('/api/tasks', valid('query', TaskListQuery), (c) => {
      const { state, limit } = c.req.valid('query')
      return c.json(store.tasks(state ? { states: state, limit } : { limit }))
    })

    .get('/api/tasks/:id', valid('param', TaskIdParam), (c) => {
      const task = store.task(c.req.valid('param').id)
      if (!task) return c.json({ error: `unknown task ${c.req.valid('param').id}` }, 404)
      // The dashboard answers via the token-bound endpoint but has no other
      // channel for the credential, so the task detail doubles as its source.
      return c.json({ task, token: store.token(task.id), questions: store.openQuestions(task.id) })
    })

    .post('/api/tasks/:id/reclaim', valid('param', TaskIdParam), async (c) => {
      const { id } = c.req.valid('param')
      const task = store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      if (task.worktree === null || task.branch === null) {
        return c.json({ error: `task ${id} has no worktree to resume` }, 409)
      }
      if (isTerminal(task.state)) {
        return c.json({ error: `task ${id} is in terminal state ${task.state}` }, 409)
      }
      // Best effort: the runner only re-claims issues the tracker sees as
      // ready, so a lapsed or still-live claim is released for it to pick up.
      if (tracker !== undefined) {
        try {
          await tracker.release(id)
        } catch (err) {
          console.warn(`release ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      store.append(id, { type: 'task.reclaimed' })
      return c.json({ task: store.task(id) })
    })

    .post(
      '/api/tasks/:id/questions',
      valid('param', TaskIdParam),
      valid('json', AskBody),
      async (c) => {
        const { id } = c.req.valid('param')
        const { question, options } = c.req.valid('json')
        const task = store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        const questionId = crypto.randomUUID()
        const gateRef = await openQuestionGate(tracker, id, {
          id: questionId,
          text: question,
          options,
        })
        store.append(id, { type: 'question.asked', questionId, question, options, gateRef })
        store.append(id, {
          type: 'task.state',
          from: task.state,
          to: 'awaiting_answer',
        })
        void notifyChannels(notify, store, `question from ${id}`, question)
        return c.json({ task: store.task(id), question: store.question(questionId) }, 201)
      },
    )

    .get(
      '/api/tasks/:id/questions/:questionId/await',
      valid('param', TaskQuestionParam),
      valid('query', AwaitQuery),
      (c) => {
        const { id, questionId } = c.req.valid('param')
        const { deadlineMs } = c.req.valid('query')
        const question = store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        if (!authorized(c, store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        // An answer that landed before the poll started is not lost.
        if (question.resolvedAt !== null) return c.json({ question })

        return new Promise<Response>((resolve) => {
          let unsub: () => void = () => {}
          let timer: ReturnType<typeof setTimeout> | null = null
          function cleanup(): void {
            if (timer !== null) clearTimeout(timer)
            unsub()
            c.req.raw.signal.removeEventListener('abort', cleanup)
          }
          unsub = store.subscribe((event) => {
            if (event.taskId !== id) return
            const resolved =
              event.type === 'question.timedout' ||
              (event.type === 'question.answered' && event.questionId === questionId)
            if (!resolved) return
            cleanup()
            resolve(c.json({ question: store.question(questionId) }))
          })
          timer = setTimeout(() => {
            store.append(id, { type: 'question.timedout', questionId })
            cleanup()
            resolve(c.json({ question: store.question(questionId) }))
          }, deadlineMs)
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
        })
      },
    )

    .post(
      '/api/tasks/:id/questions/:questionId/answer',
      valid('param', TaskQuestionParam),
      valid('json', AnswerBody),
      async (c) => {
        const { id, questionId } = c.req.valid('param')
        const { answer, via } = c.req.valid('json')
        const task = store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        if (!authorized(c, store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        const question = store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        // Timed out is not answered: a late reply still resumes the parked runner.
        if (question.answer !== null) {
          return c.json({ error: `question ${questionId} already answered` }, 409)
        }
        store.append(id, { type: 'question.answered', questionId, answer, via })
        // Only an awaiting task moves; a question answered after the runner
        // escalated is recorded but must not yank the task out of needs_human.
        if (task.state === 'awaiting_answer') {
          store.append(id, { type: 'task.state', from: task.state, to: 'implementing' })
        }
        await resolveQuestionGate(tracker, question.gateRef)
        return c.json({ task: store.task(id), question: store.question(questionId) })
      },
    )

    .get('/api/events', valid('query', EventQuery), (c) => {
      const { taskId, sinceSeq, limit } = c.req.valid('query')
      return c.json(store.events(taskId ? { taskId, sinceSeq, limit } : { sinceSeq, limit }))
    })

    .get('/api/stream', valid('query', StreamQuery), (c) => {
      const { taskId, sinceSeq } = c.req.valid('query')
      // A browser resends the last id it saw on reconnect; that beats whatever
      // sinceSeq was baked into the EventSource url when it first connected.
      const resumed = Number(c.req.header('Last-Event-ID'))
      const from = Number.isInteger(resumed) && resumed >= 0 ? resumed : sinceSeq
      return eventStream(
        c,
        store,
        taskId === undefined ? { sinceSeq: from } : { taskId, sinceSeq: from },
      )
    })

    .get('/api/questions', valid('query', QuestionQuery), (c) => {
      const { taskId } = c.req.valid('query')
      return c.json(store.openQuestions(taskId))
    })

    .notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404))

    .onError((err, c) => {
      console.error(err)
      return c.json({ error: err.message }, 500)
    })
}

export type AppType = ReturnType<typeof createApp>
