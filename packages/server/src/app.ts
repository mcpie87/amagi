import type { Notifier, Store } from '@amagi/core'
import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import { Hono } from 'hono'
import * as z from 'zod'
import {
  AnswerBody,
  AskBody,
  AwaitQuery,
  EventQuery,
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

export function createApp({ store, notify = [] }: ServerDeps) {
  return new Hono()
    .get('/api/health', (c) => c.json({ ok: true }))

    .get('/api/tasks', valid('query', TaskListQuery), (c) => {
      const { state, limit } = c.req.valid('query')
      return c.json(store.tasks(state ? { states: state, limit } : { limit }))
    })

    .get('/api/tasks/:id', valid('param', TaskIdParam), (c) => {
      const task = store.task(c.req.valid('param').id)
      if (!task) return c.json({ error: `unknown task ${c.req.valid('param').id}` }, 404)
      return c.json({ task, questions: store.openQuestions(task.id) })
    })

    .post('/api/tasks/:id/questions', valid('param', TaskIdParam), valid('json', AskBody), (c) => {
      const { id } = c.req.valid('param')
      const { question, options } = c.req.valid('json')
      const task = store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      const questionId = crypto.randomUUID()
      store.append(id, { type: 'question.asked', questionId, question, options, gateRef: null })
      store.append(id, {
        type: 'task.state',
        from: task.state,
        to: 'awaiting_answer',
      })
      void notifyChannels(notify, store, `question from ${id}`, question)
      return c.json({ task: store.task(id), question: store.question(questionId) }, 201)
    })

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
      (c) => {
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
        if (question.resolvedAt !== null) {
          return c.json({ error: `question ${questionId} already resolved` }, 409)
        }
        store.append(id, { type: 'question.answered', questionId, answer, via })
        store.append(id, { type: 'task.state', from: task.state, to: 'implementing' })
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
