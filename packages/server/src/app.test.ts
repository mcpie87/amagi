import { beforeEach, describe, expect, test } from 'bun:test'
import { openDatabase, type QuestionRow, Store, type TaskRow } from '@amagi/core'
import { hc } from 'hono/client'
import { type AppType, createApp } from './app.ts'

let store: Store
let app: AppType

const claim = (id: string, title = `work on ${id}`) =>
  store.append(id, { type: 'task.claimed', title, tracker: 'beads' })

beforeEach(() => {
  store = new Store(openDatabase(':memory:'))
  app = createApp({ store })
})

describe('GET /api/tasks', () => {
  test('returns the store projection newest first', async () => {
    claim('bd-1')
    claim('bd-2')
    const res = await app.request('/api/tasks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as TaskRow[]
    expect(body.map((t) => t.id)).toEqual(['bd-2', 'bd-1'])
    expect(body[0]?.state).toBe('claimed')
  })

  test('filters by repeated and comma separated state', async () => {
    claim('bd-1')
    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const repeated = await app.request('/api/tasks?state=claimed&state=worktree_ready')
    expect(((await repeated.json()) as TaskRow[]).map((t) => t.id).sort()).toEqual(['bd-1', 'bd-2'])

    const csv = await app.request('/api/tasks?state=worktree_ready')
    expect(((await csv.json()) as TaskRow[]).map((t) => t.id)).toEqual(['bd-2'])
  })

  test('rejects an unknown state with a 400 and a readable error', async () => {
    const res = await app.request('/api/tasks?state=nonsense')
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  test('rejects a limit outside the allowed range', async () => {
    expect((await app.request('/api/tasks?limit=0')).status).toBe(400)
    expect((await app.request('/api/tasks?limit=abc')).status).toBe(400)
  })
})

describe('GET /api/tasks/:id', () => {
  test('returns the task with its open questions', async () => {
    claim('bd-1')
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which registry?',
      options: ['npm', 'nexus'],
      gateRef: null,
    })
    const res = await app.request('/api/tasks/bd-1')
    const body = (await res.json()) as { task: TaskRow; questions: QuestionRow[] }
    expect(body.task.id).toBe('bd-1')
    expect(body.questions).toHaveLength(1)
    expect(body.questions[0]?.options).toEqual(['npm', 'nexus'])
  })

  test('404s on an unknown id', async () => {
    const res = await app.request('/api/tasks/nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('nope')
  })
})

describe('GET /api/events', () => {
  test('replays from a sequence number without repeating it', async () => {
    const first = claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await app.request(`/api/events?sinceSeq=${first.seq}`)
    const body = (await res.json()) as { seq: number; type: string }[]
    expect(body).toHaveLength(1)
    expect(body[0]?.type).toBe('task.state')
  })

  test('scopes to one task', async () => {
    claim('bd-1')
    claim('bd-2')
    const res = await app.request('/api/events?taskId=bd-2')
    const body = (await res.json()) as { taskId: string | null }[]
    expect(body.every((e) => e.taskId === 'bd-2')).toBe(true)
  })
})

describe('GET /api/questions', () => {
  test('lists only unresolved questions', async () => {
    claim('bd-1')
    for (const id of ['q1', 'q2']) {
      store.append('bd-1', {
        type: 'question.asked',
        questionId: id,
        question: id,
        options: [],
        gateRef: null,
      })
    }
    store.append('bd-1', { type: 'question.answered', questionId: 'q1', answer: 'yes', via: 'web' })
    const res = await app.request('/api/questions')
    const body = (await res.json()) as QuestionRow[]
    expect(body.map((q) => q.id)).toEqual(['q2'])
  })
})

test('unknown routes answer with the shared error shape', async () => {
  const res = await app.request('/api/nope')
  expect(res.status).toBe(404)
  expect((await res.json()) as { error: string }).toHaveProperty('error')
})

/**
 * The dashboard consumes these routes through hono/client, so the response
 * types have to come out of the app with no hand written API types. This
 * fails at typecheck, not at runtime, if the route chain stops inferring.
 */
test('hono/client infers the store projections', async () => {
  claim('bd-1')
  const client = hc<AppType>('http://localhost', { fetch: app.request })

  const tasks = await client.api.tasks.$get({ query: {} })
  if (tasks.status !== 200) throw new Error('expected 200')
  const rows: TaskRow[] = await tasks.json()
  expect(rows[0]?.id).toBe('bd-1')

  const detail = await client.api.tasks[':id'].$get({ param: { id: 'bd-1' } })
  if (detail.status !== 200) throw new Error('expected 200')
  const body: { task: TaskRow; questions: QuestionRow[] } = await detail.json()
  expect(body.task.title).toBe('work on bd-1')
})
