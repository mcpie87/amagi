import { beforeEach, describe, expect, test } from 'bun:test'
import {
  type BeadsBlocker,
  type BeadsIssue,
  type CreateTrackerTask,
  type GateRef,
  openDatabase,
  type ProjectedQuestion,
  type ProjectedTask,
  type Question,
  type RunServiceApi,
  Store,
  type Tracker,
  type TrackerCapabilities,
  type TrackerStatus,
  type TrackerTask,
  type UpdateTrackerTask,
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
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  readonly opened: Question[] = []
  readonly resolved: string[] = []
  readonly released: string[] = []
  releaseError: Error | null = null

  async ready(): Promise<TrackerTask[]> {
    return []
  }
  async claim(): Promise<TrackerTask | null> {
    return null
  }
  async get(): Promise<TrackerTask | null> {
    return null
  }
  async createTask(_input: CreateTrackerTask): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async updateTask(_id: string, _input: UpdateTrackerTask): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(id: string): Promise<void> {
    this.released.push(id)
    if (this.releaseError !== null) throw this.releaseError
  }
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
    const body = (await res.json()) as ProjectedTask[]
    expect(body.map((t) => t.id)).toEqual(['bd-2', 'bd-1'])
    expect(body[0]?.state).toBe('claimed')
  })

  test('filters by repeated and comma separated state', async () => {
    claim('bd-1')
    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const repeated = await app.request('/api/tasks?state=claimed&state=worktree_ready')
    expect(((await repeated.json()) as ProjectedTask[]).map((t) => t.id).sort()).toEqual([
      'bd-1',
      'bd-2',
    ])

    const csv = await app.request('/api/tasks?state=worktree_ready')
    expect(((await csv.json()) as ProjectedTask[]).map((t) => t.id)).toEqual(['bd-2'])
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
          dependencies: [],
          childCount: 0,
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

class FakeIssueTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: true, edit: true, dependencies: true }
  readonly created: CreateTrackerTask[] = []
  readonly updated: { id: string; input: UpdateTrackerTask }[] = []
  issues = new Map<string, BeadsIssue>()
  private seq = 0

  seed(partial: Partial<BeadsIssue>): BeadsIssue {
    const issue: BeadsIssue = {
      id: `bd-${this.seq++}`,
      title: 'Seeded',
      description: '',
      status: 'open',
      priority: null,
      type: 'task',
      url: null,
      acceptanceCriteria: null,
      assignee: null,
      labels: [],
      parent: null,
      dependencies: [],
      childCount: 0,
      ...partial,
    }
    this.issues.set(issue.id, issue)
    return issue
  }

  getIssue(id: string): BeadsIssue | null {
    return this.issues.get(id) ?? null
  }

  async ready(): Promise<TrackerTask[]> {
    return [...this.issues.values()]
  }
  async claim(): Promise<TrackerTask | null> {
    return null
  }
  async get(id: string): Promise<TrackerTask | null> {
    return this.issues.get(id) ?? null
  }
  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    this.created.push(input)
    const blocker = (id: string): BeadsBlocker => ({
      id,
      title: id,
      description: '',
      status: 'open',
      priority: null,
      type: null,
      url: null,
      labels: [],
    })
    return this.seed({
      title: input.title,
      description: input.description,
      priority: input.priority,
      acceptanceCriteria: input.acceptanceCriteria,
      labels: input.labels,
      dependencies: input.dependencies.map(blocker),
    })
  }
  async updateTask(id: string, input: UpdateTrackerTask): Promise<TrackerTask> {
    this.updated.push({ id, input })
    const issue = this.issues.get(id)
    if (issue === undefined) throw new Error(`unknown issue ${id}`)
    const { dependencies, ...fields } = input
    const next: BeadsIssue = {
      ...issue,
      ...(fields.title === undefined ? {} : { title: fields.title }),
      ...(fields.description === undefined ? {} : { description: fields.description }),
      ...(fields.priority === undefined ? {} : { priority: fields.priority }),
      ...(fields.acceptanceCriteria === undefined
        ? {}
        : { acceptanceCriteria: fields.acceptanceCriteria }),
      ...(fields.labels === undefined ? {} : { labels: fields.labels }),
      // keep the seeded blocker objects when the ids are unchanged
      dependencies:
        dependencies === undefined
          ? issue.dependencies
          : [
              ...dependencies.add.map((id) => ({
                id,
                title: id,
                description: '',
                status: 'open' as const,
                priority: null,
                type: null,
                url: null,
                labels: [],
              })),
              ...issue.dependencies.filter((d) => !dependencies.remove.includes(d.id)),
            ],
    }
    this.issues.set(id, next)
    return next
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(): Promise<void> {}
  async close(): Promise<void> {}
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'g', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return false
  }
  async resolveGate(): Promise<void> {}
}

function issueApp(tracker: Tracker) {
  return createApp({
    store,
    tracker,
    listIssues: async () => [],
    getIssue: async (id) => {
      if (tracker instanceof FakeIssueTracker) return tracker.getIssue(id)
      return null
    },
  })
}

describe('issue mutations', () => {
  test('POST /api/issues creates through the tracker and returns the issue', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Plan the board',
        description: 'Make it writable',
        acceptanceCriteria: 'It saves',
        priority: 1,
        labels: ['ui'],
        dependencies: [],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as BeadsIssue
    expect(body.title).toBe('Plan the board')
    expect(body.priority).toBe(1)
    expect(body.labels).toEqual(['ui'])
    expect(tracker.created).toHaveLength(1)
    expect(tracker.created[0]).toMatchObject({ title: 'Plan the board' })
  })

  test('POST /api/issues surfaces an unsupported tracker explicitly', async () => {
    app = createApp({ store, tracker: new FakeGateTracker() })
    const res = await app.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('does not support')
  })

  test('POST /api/issues rejects an empty title', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(tracker.created).toHaveLength(0)
  })

  test('PATCH /api/issues/:id updates fields and diffs dependencies', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({
      id: 'bd-1',
      title: 'Old',
      dependencies: [
        {
          id: 'bd-0',
          title: 'd0',
          description: '',
          status: 'open',
          priority: null,
          type: null,
          url: null,
          labels: [],
        },
      ],
    })
    app = issueApp(tracker)

    const res = await app.request('/api/issues/bd-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'New',
        priority: 2,
        labels: ['y'],
        dependencies: ['bd-0', 'bd-9'],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as BeadsIssue
    expect(body.title).toBe('New')
    expect(tracker.updated).toHaveLength(1)
    expect(tracker.updated[0]?.input).toMatchObject({
      title: 'New',
      dependencies: { add: ['bd-9'], remove: [] },
    })
  })

  test('PATCH /api/issues/:id rejects dependency edits on a tracker without them', async () => {
    const tracker = new FakeGateTracker()
    app = createApp({ store, tracker })
    const res = await app.request('/api/issues/bd-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dependencies: ['bd-9'] }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('managing dependencies')
  })

  test('PATCH /api/issues/:id surfaces an unsupported tracker explicitly', async () => {
    app = createApp({ store, tracker: new FakeGateTracker() })
    const res = await app.request('/api/issues/bd-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('does not support')
  })

  test('GET /api/issues/:id returns the issue detail', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({ id: 'bd-1', labels: ['x'] })
    app = issueApp(tracker)
    const res = await app.request('/api/issues/bd-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as BeadsIssue
    expect(body.id).toBe('bd-1')
    expect(body.labels).toEqual(['x'])
  })

  test('GET /api/issues/:id 404s on an unknown issue', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/issues/nope')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/tasks/:id/reclaim', () => {
  const stuckTask = (id: string) => {
    claim(id)
    store.append(id, {
      type: 'worktree.created',
      path: `/tmp/wt/${id}`,
      branch: `amagi/${id}-x`,
    })
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  }

  test('returns a stuck task with a recorded worktree to the queue and releases it', async () => {
    const tracker = new FakeGateTracker()
    app = createApp({ store, tracker })
    stuckTask('bd-1')
    const res = await app.request('/api/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('queued')
    expect(body.task.worktree).toBe('/tmp/wt/bd-1')
    expect(body.task.branch).toBe('amagi/bd-1-x')
    expect(tracker.released).toEqual(['bd-1'])
  })

  test('reclaims even when releasing the tracker claim fails', async () => {
    const tracker = new FakeGateTracker()
    tracker.releaseError = new Error('bd down')
    app = createApp({ store, tracker })
    stuckTask('bd-1')
    const res = await app.request('/api/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()) as { task: ProjectedTask }).toMatchObject({
      task: { state: 'queued' },
    })
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/tasks/nope/reclaim', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('409s when the task has no worktree to resume', async () => {
    claim('bd-1')
    const res = await app.request('/api/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('409s when the task already reached a terminal state', async () => {
    stuckTask('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'needs_human' })
    const res = await app.request('/api/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('reclaims a cancelled task so its preserved worktree can be resumed', async () => {
    const tracker = new FakeGateTracker()
    app = createApp({ store, tracker })
    stuckTask('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'cancelled' })
    const res = await app.request('/api/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('queued')
    expect(body.task.worktree).toBe('/tmp/wt/bd-1')
    expect(tracker.released).toEqual(['bd-1'])
  })
})

describe('runner endpoints', () => {
  const stubRunner = (over: Partial<RunServiceApi> = {}): RunServiceApi => ({
    status: async () => ({
      name: 'test',
      available: true,
      capacity: 1,
      running: [],
      startedAt: {},
      resources: {},
      tasks: {},
      autoQueue: false,
    }),
    start: async () => ({ ok: true, taskId: 'bd-1' }),
    stop: async () => ({ ok: true, taskId: 'bd-1' }),
    retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
    setMaxParallel: () => {},
    setAutoQueue: () => {},
    ...over,
  })
  const post = (path: string, body?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

  test('GET /api/runner reports availability and capacity', async () => {
    app = createApp({
      store,
      runner: stubRunner({
        status: async () => ({
          name: 'test',
          available: false,
          capacity: 1,
          running: ['bd-1'],
          startedAt: {},
          resources: {},
          tasks: {},
          autoQueue: false,
        }),
      }),
    })
    const res = await app.request('/api/runner')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: false, capacity: 1, running: ['bd-1'] })
  })

  test('runner endpoints are 501 without a runner service', async () => {
    expect((await app.request('/api/runner')).status).toBe(501)
    expect((await post('/api/runs', '{}')).status).toBe(501)
    expect((await post('/api/runs/bd-1/stop')).status).toBe(501)
  })

  test('POST /api/runs launches the next ready task', async () => {
    const started: (string | undefined)[] = []
    app = createApp({
      store,
      runner: stubRunner({
        start: async (taskId) => {
          started.push(taskId)
          return { ok: true, taskId: 'bd-1' }
        },
      }),
    })
    const res = await post('/api/runs', '{}')
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ taskId: 'bd-1' })
    expect(started).toEqual([undefined])
  })

  test('POST /api/runs forwards a task id and rejects an invalid body', async () => {
    const started: (string | undefined)[] = []
    app = createApp({
      store,
      runner: stubRunner({
        start: async (taskId) => {
          started.push(taskId)
          return { ok: true, taskId: 'bd-9' }
        },
      }),
    })
    const specific = await post('/api/runs', '{"taskId":"bd-9"}')
    expect(specific.status).toBe(201)
    expect(started).toEqual(['bd-9'])
    expect((await post('/api/runs', '{"taskId":123}')).status).toBe(400)
  })

  test('POST /api/runs propagates a launch failure', async () => {
    app = createApp({
      store,
      runner: stubRunner({
        start: async () => ({ ok: false, status: 409, error: 'runner at capacity (1/1)' }),
      }),
    })
    const res = await post('/api/runs', '{}')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'runner at capacity (1/1)' })
  })

  test('POST /api/runs/:id/stop forwards to the runner and propagates failures', async () => {
    const stopped: string[] = []
    app = createApp({
      store,
      runner: stubRunner({
        stop: async (id) => {
          stopped.push(id)
          return id === 'bd-1'
            ? { ok: true, taskId: id }
            : { ok: false, status: 404, error: `task ${id} is not running here` }
        },
      }),
    })
    const ok = await post('/api/runs/bd-1/stop')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ taskId: 'bd-1' })
    expect(stopped).toEqual(['bd-1'])

    expect((await post('/api/runs/bd-9/stop')).status).toBe(404)
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
    const body = (await res.json()) as {
      task: ProjectedTask
      token: string
      questions: ProjectedQuestion[]
    }
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
    const body = (await res.json()) as ProjectedQuestion[]
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
    const body = (await res.json()) as { task: ProjectedTask; question: ProjectedQuestion }
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
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question

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
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question
    await answer('bd-1', q.id, 'npm', token('bd-1'))

    const res = await awaitQ('bd-1', q.id, token('bd-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: ProjectedQuestion }
    expect(body.question.answer).toBe('npm')
    expect(body.question.resolvedAt).not.toBeNull()
  })

  test('awaiting holds the request open until the answer arrives', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question

    const pending = awaitQ('bd-1', q.id, token('bd-1'))
    const answered = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(answered.status).toBe(200)

    const res = await pending
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: ProjectedQuestion }
    expect(body.question.answer).toBe('npm')
    expect(store.task('bd-1')?.state).toBe('implementing')
  })

  test('awaiting times out and marks the question resolved', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question
    const res = await awaitQ('bd-1', q.id, token('bd-1'), 20)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { question: ProjectedQuestion }
    expect(body.question.resolvedAt).not.toBeNull()
    expect(store.question(q.id)?.answer).toBeNull()
  })

  test('a question that timed out can still be answered later', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question
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
    const body = (await res.json()) as { question: ProjectedQuestion }

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
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question

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
  const rows: ProjectedTask[] = await tasks.json()
  expect(rows[0]?.id).toBe('bd-1')

  const detail = await client.api.tasks[':id'].$get({ param: { id: 'bd-1' } })
  if (detail.status !== 200) throw new Error('expected 200')
  const body: { task: ProjectedTask; questions: ProjectedQuestion[] } = await detail.json()
  expect(body.task.title).toBe('work on bd-1')
})
