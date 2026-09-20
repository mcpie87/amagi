import type { Store } from '@amagi/core'
import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import { Hono } from 'hono'
import * as z from 'zod'
import { EventQuery, QuestionQuery, StreamQuery, TaskIdParam, TaskListQuery } from './schemas.ts'
import { eventStream } from './stream.ts'

export type ServerDeps = {
  store: Store
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

export function createApp({ store }: ServerDeps) {
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
