import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  BeadsIssue,
  CreateTrackerTask,
  GateRef,
  Question,
  QuestionRow,
  RunServiceApi,
  Store,
  TaskRow,
  Tracker,
  TrackerCapabilities,
  TrackerStatus,
  TrackerTask,
  UpdateTrackerTask,
} from '@amagi/core'
import { hc } from 'hono/client'
import { type AppType, createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
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
  readonly closed: { id: string; reason?: string }[] = []
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
  async close(id: string, reason?: string): Promise<void> {
    this.closed.push({ id, ...(reason === undefined ? {} : { reason }) })
  }
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

afterEach(() => {
  ws.cleanup()
})

describe('GET /api/repos/:repo/tasks', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('returns the store projection newest first', async () => {
    claim('bd-1')
    claim('bd-2')
    const res = await app.request('/api/repos/repo1/tasks')
    expect(res.status).toBe(200)
    const body = (await res.json()) as TaskRow[]
    expect(body.map((t) => t.id)).toEqual(['bd-2', 'bd-1'])
    expect(body[0]?.state).toBe('claimed')
  })

  test('filters by repeated and comma separated state', async () => {
    claim('bd-1')
    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const repeated = await app.request('/api/repos/repo1/tasks?state=claimed&state=worktree_ready')
    expect(((await repeated.json()) as TaskRow[]).map((t) => t.id).sort()).toEqual(['bd-1', 'bd-2'])

    const csv = await app.request('/api/repos/repo1/tasks?state=worktree_ready')
    expect(((await csv.json()) as TaskRow[]).map((t) => t.id)).toEqual(['bd-2'])
  })

  test('rejects an unknown state with a 400 and a readable error', async () => {
    const res = await app.request('/api/repos/repo1/tasks?state=nonsense')
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toHaveProperty('error')
  })

  test('rejects a limit outside the allowed range', async () => {
    expect((await app.request('/api/repos/repo1/tasks?limit=0')).status).toBe(400)
    expect((await app.request('/api/repos/repo1/tasks?limit=abc')).status).toBe(400)
  })

  test('404s for an unknown repo', async () => {
    expect((await app.request('/api/repos/nope/tasks')).status).toBe(404)
  })
})

describe('identical issue ids across repos do not collide', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1', 'repo2'])
    app = createApp({ workspaces: ws.workspaces })
  })

  test('each repo sees only its own task under the same id', async () => {
    const one = ws.store('repo1')
    const two = ws.store('repo2')
    one.append('42', { type: 'task.claimed', title: 'repo one issue', tracker: 'beads' })
    two.append('42', { type: 'task.claimed', title: 'repo two issue', tracker: 'beads' })

    const body = (await (await app.request('/api/repos/repo1/tasks/42')).json()) as {
      task: TaskRow
    }
    expect(body.task.title).toBe('repo one issue')
    expect(one.token('42')).not.toBe(two.token('42'))

    const list1 = (await (await app.request('/api/repos/repo1/tasks')).json()) as TaskRow[]
    expect(list1).toHaveLength(1)
    const list2 = (await (await app.request('/api/repos/repo2/tasks')).json()) as TaskRow[]
    expect(list2).toHaveLength(1)
  })

  test('an event stream is scoped to one repo', async () => {
    const one = ws.store('repo1')
    one.append('1', { type: 'task.claimed', title: 'a', tracker: 'beads' })
    ws.store('repo2').append('1', { type: 'task.claimed', title: 'b', tracker: 'beads' })
    const body = (await (await app.request('/api/repos/repo1/events')).json()) as {
      taskId: string | null
    }[]
    expect(body.every((e) => e.taskId === '1')).toBe(true)
    expect(body).toHaveLength(1)
  })
})

describe('GET /api/repos/:repo/issues', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'], { trackerFor: () => new FakeGateTracker() })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('reports when issue browsing is unavailable (non-beads tracker)', async () => {
    const res = await app.request('/api/repos/repo1/issues')
    expect(res.status).toBe(501)
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
      ...partial,
    }
    this.issues.set(issue.id, issue)
    return issue
  }

  list(): BeadsIssue[] {
    return [...this.issues.values()]
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
    const blocker = (id: string): TrackerTask => ({
      id,
      title: id,
      description: '',
      status: 'open',
      priority: null,
      type: null,
      url: null,
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
      ...fields,
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
  ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
  store = ws.store('repo1')
  return createApp({ workspaces: ws.workspaces })
}

describe('issue mutations', () => {
  test('POST /api/repos/:repo/issues creates through the tracker and returns the issue', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/repos/repo1/issues', {
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

  test('POST /api/repos/:repo/issues surfaces an unsupported tracker explicitly', async () => {
    app = issueApp(new FakeGateTracker())
    const res = await app.request('/api/repos/repo1/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('does not support')
  })

  test('POST /api/repos/:repo/issues rejects an empty title', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/repos/repo1/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(res.status).toBe(400)
    expect(tracker.created).toHaveLength(0)
  })

  test('PATCH /api/repos/:repo/issues/:id updates fields and diffs dependencies', async () => {
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
        },
      ],
    })
    app = issueApp(tracker)

    const res = await app.request('/api/repos/repo1/issues/bd-1', {
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

  test('PATCH /api/repos/:repo/issues/:id rejects dependency edits on a tracker without them', async () => {
    app = issueApp(new FakeGateTracker())
    const res = await app.request('/api/repos/repo1/issues/bd-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dependencies: ['bd-9'] }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('managing dependencies')
  })

  test('PATCH /api/repos/:repo/issues/:id surfaces an unsupported tracker explicitly', async () => {
    app = issueApp(new FakeGateTracker())
    const res = await app.request('/api/repos/repo1/issues/bd-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('does not support')
  })

  test('GET /api/repos/:repo/issues/:id returns the issue detail', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({ id: 'bd-1', labels: ['x'] })
    app = issueApp(tracker)
    const res = await app.request('/api/repos/repo1/issues/bd-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as BeadsIssue
    expect(body.id).toBe('bd-1')
    expect(body.labels).toEqual(['x'])
  })

  test('GET /api/repos/:repo/issues/:id 404s on an unknown issue', async () => {
    const tracker = new FakeIssueTracker()
    app = issueApp(tracker)
    const res = await app.request('/api/repos/repo1/issues/nope')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/repos/:repo/tasks/:id/reclaim', () => {
  let tracker: FakeGateTracker

  beforeEach(() => {
    tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

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
    stuckTask('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: TaskRow }
    expect(body.task.state).toBe('claimed')
    expect(body.task.worktree).toBe('/tmp/wt/bd-1')
    expect(body.task.branch).toBe('amagi/bd-1-x')
    expect(tracker.released).toEqual(['bd-1'])
  })

  test('reclaims even when releasing the tracker claim fails', async () => {
    tracker.releaseError = new Error('bd down')
    stuckTask('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()) as { task: TaskRow }).toMatchObject({ task: { state: 'claimed' } })
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope/reclaim', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('409s when the task has no worktree to resume', async () => {
    claim('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('409s when the task reached a terminal state that cannot be retried', async () => {
    stuckTask('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'done' })
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('reclaims a cancelled task so its preserved worktree can be resumed', async () => {
    const tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    stuckTask('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'cancelled' })
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: TaskRow }
    expect(body.task.state).toBe('claimed')
    expect(body.task.worktree).toBe('/tmp/wt/bd-1')
    expect(tracker.released).toEqual(['bd-1'])
  })

  test.each(['needs_human', 'no_pr'] as const)(
    'retries a %s task so its preserved worktree can be resumed',
    async (state) => {
      const tracker = new FakeGateTracker()
      ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
      store = ws.store('repo1')
      app = createApp({ workspaces: ws.workspaces })
      stuckTask('bd-1')
      store.append('bd-1', { type: 'task.state', from: 'implementing', to: state })
      const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: TaskRow }
      expect(body.task.state).toBe('claimed')
      expect(body.task.worktree).toBe('/tmp/wt/bd-1')
      expect(tracker.released).toEqual(['bd-1'])
    },
  )
})

describe('POST /api/repos/:repo/tasks/:id/close', () => {
  let tracker: FakeGateTracker

  beforeEach(() => {
    tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  const parked = (id: string, state: 'needs_human' | 'no_pr') => {
    claim(id)
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(id, { type: 'task.state', from: 'implementing', to: state })
  }
  const close = (id: string, reason?: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(reason === undefined ? {} : { reason }) }),
    })

  test.each(['needs_human', 'no_pr'] as const)(
    'abandons a %s task, records the reason, and closes the tracker issue',
    async (state) => {
      parked('bd-1', state)
      const res = await close('bd-1', 'no longer wanted')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: TaskRow }
      expect(body.task.state).toBe('abandoned')
      expect(body.task.statusReason).toBe('no longer wanted')
      expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'no longer wanted' }])
    },
  )

  test('404s on an unknown task', async () => {
    expect((await close('nope', 'gone')).status).toBe(404)
  })

  test('409s when the task is not parked for attention', async () => {
    claim('bd-1')
    const res = await close('bd-1', 'no longer wanted')
    expect(res.status).toBe(409)
  })

  test('rejects a missing or empty reason', async () => {
    parked('bd-1', 'needs_human')
    expect((await close('bd-1')).status).toBe(400)
    expect((await close('bd-1', '   ')).status).toBe(400)
    expect(tracker.closed).toEqual([])
  })
})

describe('runner endpoints', () => {
  const stubRunner = (over: Partial<RunServiceApi> = {}): RunServiceApi => ({
    status: () => ({ available: true, capacity: 1, running: [] }),
    start: async () => ({ ok: true, taskId: 'bd-1' }),
    stop: async () => ({ ok: true, taskId: 'bd-1' }),
    ...over,
  })
  const post = (path: string, body?: string) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })

  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('GET /api/runner reports availability and capacity', async () => {
    app = createApp({
      workspaces: ws.workspaces,
      runner: stubRunner({
        status: () => ({ available: false, capacity: 1, running: ['bd-1'] }),
      }),
    })
    const res = await app.request('/api/runner')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, capacity: 1, running: ['bd-1'] })
  })

  test('runner endpoints are 501 without a runner service', async () => {
    expect((await app.request('/api/runner')).status).toBe(501)
    expect((await post('/api/runs', '{}')).status).toBe(501)
    expect((await post('/api/runs/bd-1/stop')).status).toBe(501)
  })

  test('POST /api/runs launches the next ready task', async () => {
    const started: (string | undefined)[] = []
    app = createApp({
      workspaces: ws.workspaces,
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
      workspaces: ws.workspaces,
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
      workspaces: ws.workspaces,
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
      workspaces: ws.workspaces,
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

describe('GET /api/repos/:repo/tasks/:id', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('returns the task with its open questions', async () => {
    claim('bd-1')
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which registry?',
      options: ['npm', 'nexus'],
      gateRef: null,
    })
    const res = await app.request('/api/repos/repo1/tasks/bd-1')
    const body = (await res.json()) as { task: TaskRow; token: string; questions: QuestionRow[] }
    expect(body.task.id).toBe('bd-1')
    expect(body.token).toBe(store.token('bd-1'))
    expect(body.questions).toHaveLength(1)
    expect(body.questions[0]?.options).toEqual(['npm', 'nexus'])
  })

  test('404s on an unknown id', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toContain('nope')
  })
})

describe('GET /api/repos/:repo/events', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('replays from a sequence number without repeating it', async () => {
    const first = claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await app.request(`/api/repos/repo1/events?sinceSeq=${first.seq}`)
    const body = (await res.json()) as { seq: number; type: string }[]
    expect(body).toHaveLength(1)
    expect(body[0]?.type).toBe('task.state')
  })

  test('scopes to one task', async () => {
    claim('bd-1')
    claim('bd-2')
    const res = await app.request('/api/repos/repo1/events?taskId=bd-2')
    const body = (await res.json()) as { taskId: string | null }[]
    expect(body.every((e) => e.taskId === 'bd-2')).toBe(true)
  })
})

describe('GET /api/repos/:repo/questions', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

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
    const res = await app.request('/api/repos/repo1/questions')
    const body = (await res.json()) as QuestionRow[]
    expect(body.map((q) => q.id)).toEqual(['q2'])
  })
})

describe('question channel', () => {
  let tracker: FakeGateTracker

  beforeEach(() => {
    tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  const token = (id: string) => store.token(id)
  const implementing = (id: string) => {
    for (const to of ['worktree_ready', 'implementing'] as const) {
      store.append(id, { type: 'task.state', from: null, to })
    }
  }
  const ask = (id: string, question: string, options: string[] = []) =>
    app.request(`/api/repos/repo1/tasks/${id}/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, options }),
    })
  const answer = (id: string, questionId: string, text: string, token?: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/questions/${questionId}/answer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'X-Amagi-Token': token }),
      },
      body: JSON.stringify({ answer: text }),
    })
  const awaitQ = (id: string, questionId: string, t: string, deadlineMs?: number) =>
    app.request(
      `/api/repos/repo1/tasks/${id}/questions/${questionId}/await${deadlineMs ? `?deadlineMs=${deadlineMs}` : ''}`,
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
      workspaces: ws.workspaces,
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
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: QuestionRow }).question

    const res = await answer('bd-1', q.id, 'npm', token('bd-1'))
    expect(res.status).toBe(200)
    expect(tracker.resolved).toEqual(['gate-7'])
  })
})

describe('GET /api/repos', () => {
  test('lists registered repositories with readiness', async () => {
    ws = testWorkspaces(['repo1', 'repo2'])
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      key: string
      name: string
      path: string
      ready: { name: string; ok: boolean }[]
    }[]
    expect(body.map((r) => r.key).sort()).toEqual(['repo1', 'repo2'])
    // a missing git root is reported, not thrown
    expect(body[0]?.ready.some((d) => d.ok === false)).toBe(true)
  })
})

describe('POST /api/repos (onboarding)', () => {
  test('registers a new repo without a restart and reports readiness', async () => {
    ws = testWorkspaces([])
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: process.cwd() }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { key: string; name: string; ready: unknown[] }
    expect(body.key).toBeTruthy()
    expect(Array.isArray(body.ready)).toBe(true)
    expect(ws.workspaces.list().some((e) => e.key === body.key)).toBe(true)
  })

  test('rejects a path that is not a git repository', async () => {
    ws = testWorkspaces([])
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/nonexistent-path-xyz' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/repos/:repo/run', () => {
  test('starts a run in the background for the repo', async () => {
    const tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos/repo1/run', { method: 'POST' })
    expect(res.status).toBe(202)
    await Bun.sleep(20)
    // the fake tracker has nothing ready, so the run ends without events
    expect(tracker.released).toEqual([])
  })

  test('404s for an unknown repo', async () => {
    ws = testWorkspaces(['repo1'])
    app = createApp({ workspaces: ws.workspaces })
    expect((await app.request('/api/repos/nope/run', { method: 'POST' })).status).toBe(404)
  })
})

test('unknown routes answer with the shared error shape', async () => {
  ws = testWorkspaces(['repo1'])
  app = createApp({ workspaces: ws.workspaces })
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
  ws = testWorkspaces(['repo1'])
  store = ws.store('repo1')
  app = createApp({ workspaces: ws.workspaces })
  claim('bd-1')
  const client = hc<AppType>('http://localhost', { fetch: app.request })

  const tasks = await client.api.repos[':repo'].tasks.$get({ param: { repo: 'repo1' }, query: {} })
  if (tasks.status !== 200) throw new Error('expected 200')
  const rows: TaskRow[] = await tasks.json()
  expect(rows[0]?.id).toBe('bd-1')

  const detail = await client.api.repos[':repo'].tasks[':id'].$get({
    param: { repo: 'repo1', id: 'bd-1' },
  })
  if (detail.status !== 200) throw new Error('expected 200')
  const body: { task: TaskRow; questions: QuestionRow[] } = await detail.json()
  expect(body.task.title).toBe('work on bd-1')
})
