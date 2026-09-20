import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type GateRef,
  openDatabase,
  type Question,
  type QuestionRow,
  Store,
  type TaskRow,
  type Tracker,
  type TrackerStatus,
  type TrackerTask,
} from '@amagi/core'
import { hc } from 'hono/client'
import { type AppType, createApp } from './app.ts'

let store: Store
let app: AppType

const claim = (id: string, title = `work on ${id}`) =>
  store.append(id, { type: 'task.claimed', title, tracker: 'beads' })

class FakeGateTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly opened: Question[] = []
  readonly resolved: string[] = []

  async ready(): Promise<TrackerTask[]> {
    return []
  }
  async claim(): Promise<TrackerTask | null> {
    return null
  }
  async get(): Promise<TrackerTask | null> {
    return null
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(): Promise<void> {}
  async close(): Promise<void> {}
  async openGate(_id: string, question: Question): Promise<GateRef> {
    this.opened.push(question)
    return { id: 'gate-7', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return false
  }
  async resolveGate(ref: GateRef): Promise<void> {
    this.resolved.push(ref.id)
  }
}

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

describe('GET /api/issues', () => {
  test('returns tracker issues when the tracker supports browsing', async () => {
    const issueApp = createApp({
      store,
      listIssues: async () => [
        {
          id: 'bd-1',
          title: 'Browse issues',
          description: 'Show tracker issues in the dashboard.',
          status: 'open',
          priority: 2,
          type: 'feature',
          url: null,
          acceptanceCriteria: null,
          assignee: null,
          labels: [],
          parent: null,
        },
      ],
    })
    const res = await issueApp.request('/api/issues')
    expect(res.status).toBe(200)
    expect((await res.json()) as { id: string }[]).toEqual([
      expect.objectContaining({ id: 'bd-1' }),
    ])
  })

  test('reports when issue browsing is unavailable', async () => {
    expect((await app.request('/api/issues')).status).toBe(501)
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
    const body = (await res.json()) as { task: TaskRow; token: string; questions: QuestionRow[] }
    expect(body.task.id).toBe('bd-1')
    expect(body.token).toBe(store.token('bd-1'))
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

describe('question channel', () => {
  const token = (id: string) => store.token(id)
  const implementing = (id: string) => {
    for (const to of ['worktree_ready', 'implementing'] as const) {
      store.append(id, { type: 'task.state', from: null, to })
    }
  }
  const ask = (id: string, question: string, options: string[] = []) =>
    app.request(`/api/tasks/${id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, options }),
    })
  const answer = (id: string, questionId: string, text: string, token?: string) =>
    app.request(`/api/tasks/${id}/questions/${questionId}/answer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'X-Amagi-Token': token }),
      },
      body: JSON.stringify({ answer: text }),
    })
  const awaitQ = (id: string, questionId: string, t: string, deadlineMs?: number) =>
    app.request(
      `/api/tasks/${id}/questions/${questionId}/await${deadlineMs ? `?deadlineMs=${deadlineMs}` : ''}`,
      { headers: { 'X-Amagi-Token': t } },
    )

  test('asking persists the question and parks the task', async () => {
    claim('bd-1')
    implementing('bd-1')
    const res = await ask('bd-1', 'which registry?', ['npm', 'nexus'])
    expect(res.status).toBe(201)
    const body = (await res.json()) as { task: TaskRow; question: QuestionRow }
    expect(body.task.state).toBe('awaiting_answer')
    expect(body.question.question).toBe('which registry?')
    expect(store.task('bd-1')?.state).toBe('awaiting_answer')
  })

  test('asking an unknown task is a 404', async () => {
    const res = await ask('nope', 'which registry?')
    expect(res.status).toBe(404)
  })

  test('one task cannot see or answer another tasks question', async () => {
    claim('bd-1')
    claim('bd-2')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question

    const spied = await awaitQ('bd-1', q.id, token('bd-2'))
    expect(spied.status).toBe(401)

    const stolen = await answer('bd-1', q.id, 'yes', token('bd-2'))
    expect(stolen.status).toBe(401)
    expect(store.question(q.id)?.answer).toBeNull()

    const own = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(own.status).toBe(200)
    expect(store.question(q.id)?.answer).toBe('npm')
  })

  test('an answer landing before the poll starts is not lost', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question
    await answer('bd-1', q.id, 'npm', token('bd-1'))

    const res = await awaitQ('bd-1', q.id, token('bd-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: QuestionRow }
    expect(body.question.answer).toBe('npm')
    expect(body.question.resolvedAt).not.toBeNull()
  })

  test('awaiting holds the request open until the answer arrives', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question

    const pending = awaitQ('bd-1', q.id, token('bd-1'))
    const answered = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(answered.status).toBe(200)

    const res = await pending
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: QuestionRow }
    expect(body.question.answer).toBe('npm')
    expect(store.task('bd-1')?.state).toBe('implementing')
  })

  test('awaiting times out and marks the question resolved', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question
    const res = await awaitQ('bd-1', q.id, token('bd-1'), 20)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: QuestionRow }
    expect(body.question.resolvedAt).not.toBeNull()
    expect(store.question(q.id)?.answer).toBeNull()
  })

  test('a question that timed out can still be answered later', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question
    await awaitQ('bd-1', q.id, token('bd-1'), 20)
    expect(store.question(q.id)?.resolvedAt).not.toBeNull()

    const res = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(res.status).toBe(200)
    expect(store.question(q.id)?.answer).toBe('npm')
    expect(store.task('bd-1')?.state).toBe('implementing')

    const twice = await answer('bd-1', q.id, 'again', token('bd-1'))
    expect(twice.status).toBe(409)
  })

  test('asking fires the notifiers and records notify.sent', async () => {
    const delivered: string[] = []
    const failing = {
      kind: 'broken',
      notify: async () => {
        throw new Error('channel down')
      },
    }
    app = createApp({
      store,
      notify: [
        {
          kind: 'spy',
          notify: async (title: string) => {
            delivered.push(title)
          },
        },
        failing,
      ],
    })
    claim('bd-1')
    implementing('bd-1')

    const res = await ask('bd-1', 'which registry?')
    expect(res.status).toBe(201)
    await Bun.sleep(10)

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('bd-1')
    const sent = store.events().filter((e) => e.type === 'notify.sent')
    expect(sent).toHaveLength(2)
    expect(sent.map((e) => e.type === 'notify.sent' && e.channel).sort()).toEqual(['broken', 'spy'])
  })

  test('asking opens a gate on the issue and records its ref', async () => {
    const tracker = new FakeGateTracker()
    app = createApp({ store, tracker })
    claim('bd-1')
    implementing('bd-1')
    const res = await ask('bd-1', 'which registry?', ['npm', 'nexus'])
    expect(res.status).toBe(201)
    const body = (await res.json()) as { question: QuestionRow }

    expect(tracker.opened).toHaveLength(1)
    expect(tracker.opened[0]?.id).toBe(body.question.id)
    expect(tracker.opened[0]?.text).toBe('which registry?')
    expect(store.question(body.question.id)?.gateRef).toBe('gate-7')
  })

  test('answering resolves the gate', async () => {
    const tracker = new FakeGateTracker()
    app = createApp({ store, tracker })
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question

    const res = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(res.status).toBe(200)
    expect(tracker.resolved).toEqual(['gate-7'])
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
