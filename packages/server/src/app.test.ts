import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentOutcome,
  AgentProcess,
  AgentStartOptions,
  BeadsIssue,
  CreatePrOptions,
  CreateTrackerTask,
  EpicCloseEligible,
  EpicCloseResult,
  GateRef,
  Harness,
  PrComment,
  PrDriver,
  PrInfo,
  ProjectedQuestion,
  ProjectedTask,
  PrState,
  PullRequest,
  Question,
  RunOptions,
  RunServiceApi,
  Store,
  Tracker,
  TrackerCapabilities,
  TrackerStatus,
  TrackerTask,
  UpdateTrackerTask,
} from '@amagi/core'
import { AsyncQueue, BeadsTracker, killTree, loadConfig } from '@amagi/core'
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
  readonly closed: { id: string; reason: string | undefined }[] = []
  readonly statuses: { id: string; status: TrackerStatus }[] = []
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
  async setStatus(id: string, status: TrackerStatus): Promise<void> {
    this.statuses.push({ id, status })
  }
  async release(id: string): Promise<void> {
    this.released.push(id)
    if (this.releaseError !== null) throw this.releaseError
  }
  async close(id: string, reason?: string): Promise<void> {
    this.closed.push({ id, reason })
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
    const body = (await res.json()) as ProjectedTask[]
    expect(body.map((t) => t.id)).toEqual(['bd-2', 'bd-1'])
    expect(body[0]?.state).toBe('claimed')
  })

  test('filters by repeated and comma separated state', async () => {
    claim('bd-1')
    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const repeated = await app.request('/api/repos/repo1/tasks?state=claimed&state=worktree_ready')
    expect(((await repeated.json()) as ProjectedTask[]).map((t) => t.id).sort()).toEqual([
      'bd-1',
      'bd-2',
    ])

    const csv = await app.request('/api/repos/repo1/tasks?state=worktree_ready')
    expect(((await csv.json()) as ProjectedTask[]).map((t) => t.id)).toEqual(['bd-2'])
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

class FakeMergePrDriver implements PrDriver {
  open: PrInfo[] = []
  async listOpenPrs(): Promise<PrInfo[]> {
    return this.open
  }
  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    throw new Error('unused')
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async getPrDiff(_cwd: string, _number: number): Promise<string> {
    return ''
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
  async closePr(_cwd: string, _number: number, _reason: string): Promise<void> {}
  async addLabel(_cwd: string, _number: number, _label: string): Promise<void> {}
  async removeLabel(_cwd: string, _number: number, _label: string): Promise<void> {}
}

describe('GET /api/repos/:repo/mergeable-prs', () => {
  let forge: FakeMergePrDriver
  beforeEach(() => {
    forge = new FakeMergePrDriver()
    ws = testWorkspaces(['repo1'], { forgeFor: () => forge })
    app = createApp({ workspaces: ws.workspaces })
  })

  test('returns only the PRs the forge reports as mergeable', async () => {
    forge.open = [
      {
        number: 1,
        title: 'Ready',
        body: '',
        url: 'https://github.com/owner/repo/pull/1',
        headRefName: 'amagi/am-1',
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefOid: null,
        updatedAt: '',
        labels: [],
      },
      {
        number: 2,
        title: 'Conflicted',
        body: '',
        url: 'https://github.com/owner/repo/pull/2',
        headRefName: 'amagi/am-2',
        baseRefName: 'main',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        headRefOid: null,
        updatedAt: '',
        labels: [],
      },
      {
        number: 3,
        title: 'Unknown',
        body: '',
        url: 'https://github.com/owner/repo/pull/3',
        headRefName: 'amagi/am-3',
        baseRefName: 'main',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        headRefOid: null,
        updatedAt: '',
        labels: [],
      },
      {
        number: 4,
        title: 'Clean via status',
        body: '',
        url: 'https://github.com/owner/repo/pull/4',
        headRefName: 'amagi/am-4',
        baseRefName: 'main',
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'CLEAN',
        headRefOid: null,
        updatedAt: '',
        labels: [],
      },
    ]
    const res = await app.request('/api/repos/repo1/mergeable-prs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { prs: PrInfo[] }
    expect(body.prs.map((p) => p.number)).toEqual([1, 4])
  })

  test('404s for an unknown repo', async () => {
    expect((await app.request('/api/repos/nope/mergeable-prs')).status).toBe(404)
  })

  test('501s when the repo has no forge driver', async () => {
    const noForge = testWorkspaces(['repo1'], { forgeFor: () => null })
    const noForgeApp = createApp({ workspaces: noForge.workspaces })
    const res = await noForgeApp.request('/api/repos/repo1/mergeable-prs')
    expect(res.status).toBe(501)
    noForge.cleanup()
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
      task: ProjectedTask
    }
    expect(body.task.title).toBe('repo one issue')
    expect(one.token('42')).not.toBe(two.token('42'))

    const list1 = (await (await app.request('/api/repos/repo1/tasks')).json()) as ProjectedTask[]
    expect(list1).toHaveLength(1)
    const list2 = (await (await app.request('/api/repos/repo2/tasks')).json()) as ProjectedTask[]
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

class FakeIssueTracker extends BeadsTracker {
  readonly created: CreateTrackerTask[] = []
  readonly updated: { id: string; input: UpdateTrackerTask }[] = []
  readonly released: string[] = []
  issues = new Map<string, BeadsIssue>()
  private seq = 0

  constructor() {
    super({ cwd: '/repo' })
  }

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

  override async list(): Promise<BeadsIssue[]> {
    return [...this.issues.values()]
  }

  override async getIssue(id: string): Promise<BeadsIssue | null> {
    return this.issues.get(id) ?? null
  }

  override async ready(): Promise<TrackerTask[]> {
    return [...this.issues.values()]
  }
  override async claim(): Promise<TrackerTask | null> {
    return null
  }
  override async get(id: string): Promise<TrackerTask | null> {
    return this.issues.get(id) ?? null
  }
  override async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    this.created.push(input)
    const blocker = (id: string): TrackerTask & { labels: string[] } => ({
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
  override async updateTask(id: string, input: UpdateTrackerTask): Promise<TrackerTask> {
    this.updated.push({ id, input })
    const issue = this.issues.get(id)
    if (issue === undefined) throw new Error(`unknown issue ${id}`)
    const { dependencies, ...fields } = input
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<BeadsIssue>
    const next: BeadsIssue = {
      ...issue,
      ...defined,
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
  override async heartbeat(): Promise<boolean> {
    return true
  }
  override async comment(): Promise<void> {}
  override async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  override async release(id: string): Promise<void> {
    this.released.push(id)
  }
  override async close(): Promise<void> {}
  override async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'g', advisory: false }
  }
  override async gateResolved(): Promise<boolean> {
    return false
  }
  override async resolveGate(): Promise<void> {}
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
          labels: [],
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

describe('GET /api/repos/:repo/ready-queue', () => {
  test('returns the tracker-ready queue in its given order', async () => {
    const tracker = new FakeIssueTracker()
    const a = tracker.seed({ id: 'bd-old', title: 'oldest' })
    const b = tracker.seed({ id: 'bd-new', title: 'newest' })
    app = issueApp(tracker)
    const res = await app.request('/api/repos/repo1/ready-queue')
    expect(res.status).toBe(200)
    expect((await res.json()) as TrackerTask[]).toEqual([a, b])
  })

  test('404s on an unknown repository', async () => {
    app = issueApp(new FakeIssueTracker())
    const res = await app.request('/api/repos/nope/ready-queue')
    expect(res.status).toBe(404)
  })
})

class FakeEpicTracker extends FakeIssueTracker {
  readonly eligible = new Map<string, EpicCloseEligible>()
  readonly closedReasons: { id: string; reason: string }[] = []
  private epicSeq = 0

  seedEligible(partial: Partial<EpicCloseEligible>): EpicCloseEligible {
    const epic: EpicCloseEligible = {
      id: `bd-${this.epicSeq++}`,
      title: 'Eligible epic',
      status: 'open',
      totalChildren: 7,
      closedChildren: 7,
      ...partial,
    }
    this.eligible.set(epic.id, epic)
    return epic
  }

  override async eligibleEpics(): Promise<EpicCloseEligible[]> {
    return [...this.eligible.values()]
  }

  override async closeEligibleEpics(reason: string): Promise<EpicCloseResult> {
    const closed = [...this.eligible.keys()]
    this.eligible.clear()
    this.closedReasons.push({ id: closed.join(','), reason })
    return { closed, reason }
  }
}

describe('epic close-eligible endpoints', () => {
  const post = (reason: string) =>
    app.request('/api/repos/repo1/epics/close-eligible', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    })

  test('GET reports when epic closure is unavailable (non-beads tracker)', async () => {
    ws = testWorkspaces(['repo1'], { trackerFor: () => new FakeGateTracker() })
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos/repo1/epics/close-eligible')
    expect(res.status).toBe(501)
  })

  test('GET previews the eligible epics', async () => {
    const tracker = new FakeEpicTracker()
    tracker.seedEligible({ id: 'bd-1', title: 'M4', totalChildren: 7, closedChildren: 7 })
    tracker.seedEligible({ id: 'bd-2', title: 'M6', totalChildren: 5, closedChildren: 2 })
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos/repo1/epics/close-eligible')
    expect(res.status).toBe(200)
    const body = (await res.json()) as EpicCloseEligible[]
    expect(body.map((e) => e.id)).toEqual(['bd-1', 'bd-2'])
    expect(body[0]).toMatchObject({ title: 'M4', totalChildren: 7, closedChildren: 7 })
  })

  test('POST closes with the reason and reports the closed epics', async () => {
    const tracker = new FakeEpicTracker()
    tracker.seedEligible({ id: 'bd-1' })
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    app = createApp({ workspaces: ws.workspaces })
    const res = await post('All children completed')
    expect(res.status).toBe(200)
    const body = (await res.json()) as EpicCloseResult
    expect(body).toEqual({ closed: ['bd-1'], reason: 'All children completed' })
    expect(tracker.closedReasons).toEqual([{ id: 'bd-1', reason: 'All children completed' }])
  })

  test('POST rejects a blank reason', async () => {
    const tracker = new FakeEpicTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    app = createApp({ workspaces: ws.workspaces })
    expect((await post('   ')).status).toBe(400)
    expect(tracker.closedReasons).toHaveLength(0)
  })

  test('POST is 501 on a tracker without epic closure', async () => {
    ws = testWorkspaces(['repo1'], { trackerFor: () => new FakeGateTracker() })
    app = createApp({ workspaces: ws.workspaces })
    expect((await post('x')).status).toBe(501)
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
    const body = (await res.json()) as { task: ProjectedTask }
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
    expect((await res.json()) as { task: ProjectedTask }).toMatchObject({
      task: { state: 'claimed' },
    })
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope/reclaim', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('restarts a task with no recorded worktree, letting the runner start fresh', async () => {
    const tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    claim('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reclaim', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('claimed')
    expect(body.task.worktree).toBeNull()
    expect(tracker.released).toEqual(['bd-1'])
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
    const body = (await res.json()) as { task: ProjectedTask }
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
      const body = (await res.json()) as { task: ProjectedTask }
      expect(body.task.state).toBe('claimed')
      expect(body.task.worktree).toBe('/tmp/wt/bd-1')
      expect(tracker.released).toEqual(['bd-1'])
    },
  )
})

describe('POST /api/repos/:repo/tasks/:id/reset', () => {
  let tracker: FakeGateTracker

  beforeEach(() => {
    tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    // git runs in the repo root to drop the branch, so it has to exist.
    mkdirSync(ws.workspaces.get('repo1')?.root ?? '', { recursive: true })
  })

  const parked = (id: string, to: 'cancelled' | 'needs_human' | 'no_pr' | 'pr_open') => {
    claim(id)
    store.append(id, { type: 'worktree.created', path: `/tmp/wt/${id}`, branch: `amagi/${id}-x` })
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(id, { type: 'agent.exited', role: 'implement', exitCode: 0, sessionId: 'sess-1' })
    if (to === 'pr_open') {
      store.append(id, { type: 'task.state', from: 'implementing', to: 'checks' })
      store.append(id, { type: 'task.state', from: 'checks', to: 'committed' })
      store.append(id, { type: 'task.state', from: 'committed', to: 'pr_open' })
    } else {
      store.append(id, { type: 'task.state', from: 'implementing', to })
    }
  }

  test.each(['cancelled', 'needs_human', 'no_pr'] as const)(
    'starts a %s task over as a fresh attempt with no worktree or session',
    async (state) => {
      parked('bd-1', state)
      const res = await app.request('/api/repos/repo1/tasks/bd-1/reset', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: ProjectedTask }
      expect(body.task).toMatchObject({
        state: 'claimed',
        attempt: 2,
        worktree: null,
        branch: null,
        sessionId: null,
      })
      expect(tracker.released).toEqual(['bd-1'])
      expect(
        store.events({ taskId: 'bd-1', limit: 100 }).some((e) => e.type === 'task.reset'),
      ).toBe(true)
    },
  )

  test('starts over an in-flight task stuck before it got a worktree', async () => {
    claim('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reset', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task).toMatchObject({
      state: 'claimed',
      attempt: 2,
    })
    expect(tracker.released).toEqual(['bd-1'])
  })

  test('409s on an in-flight task that has a worktree', async () => {
    claim('bd-1')
    store.append('bd-1', { type: 'worktree.created', path: '/tmp/wt/bd-1', branch: 'amagi/bd-1-x' })
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reset', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('409s on a task whose PR is open', async () => {
    parked('bd-1', 'pr_open')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/reset', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(store.task('bd-1')?.attempt).toBe(1)
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope/reset', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/repos/:repo/tasks/:id/filed-as-error', () => {
  const parkedError = (id: string, reason: string) => {
    claim(id)
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(id, { type: 'task.state', from: 'implementing', to: 'needs_human', reason })
  }
  const file = (id: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/filed-as-error`, {
      method: 'POST',
    })

  test('files the error as a human task, blocks the original on it and releases it', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({ id: 'bd-1', title: 'work on bd-1' })
    app = issueApp(tracker)
    parkedError('bd-1', 'agent failed: model quota exhausted')

    const res = await file('bd-1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask; errorTask: BeadsIssue }

    expect(tracker.created).toHaveLength(1)
    expect(tracker.created[0]).toMatchObject({
      title: 'Error: work on bd-1',
      labels: ['human'],
    })
    expect(tracker.created[0]?.description).toContain('agent failed: model quota exhausted')
    expect(tracker.updated).toHaveLength(1)
    expect(tracker.updated[0]?.input).toEqual({
      dependencies: { add: [body.errorTask.id], remove: [] },
    })
    expect(tracker.released).toEqual(['bd-1'])
    expect(body.errorTask.labels).toEqual(['human'])
    const event = store.events({ taskId: 'bd-1' }).find((e) => e.type === 'retry.filed_as_error')
    expect(event).toMatchObject({
      type: 'retry.filed_as_error',
      errorTaskId: body.errorTask.id,
      reason: 'agent failed: model quota exhausted',
    })
  })

  test('404s on an unknown task', async () => {
    app = issueApp(new FakeIssueTracker())
    expect((await file('nope')).status).toBe(404)
  })

  test('409s when the task is not parked for human attention', async () => {
    app = issueApp(new FakeIssueTracker())
    claim('bd-1')
    const res = await file('bd-1')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain(
      'not waiting for human attention',
    )
  })

  test('409s when the task has no recorded error to carry', async () => {
    app = issueApp(new FakeIssueTracker())
    parkedError('bd-1', '  ')
    const res = await file('bd-1')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('no recorded error')
  })

  test('501s on a tracker without create or dependency support', async () => {
    app = issueApp(new FakeGateTracker())
    parkedError('bd-1', 'agent failed')
    const res = await file('bd-1')
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: string }).error).toContain('does not support')
  })

  test('filing the same failure twice creates one error bead and reuses it', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({ id: 'bd-1', title: 'work on bd-1' })
    app = issueApp(tracker)
    parkedError('bd-1', 'agent failed: model quota exhausted')

    const firstBody = (await (await file('bd-1')).json()) as { errorTask: BeadsIssue }
    const secondBody = (await (await file('bd-1')).json()) as { errorTask: BeadsIssue }

    expect(tracker.created).toHaveLength(1)
    expect(secondBody.errorTask.id).toBe(firstBody.errorTask.id)
  })

  test('a recurring failure after the prior error task was closed files a new bead', async () => {
    const tracker = new FakeIssueTracker()
    tracker.seed({ id: 'bd-1', title: 'work on bd-1' })
    app = issueApp(tracker)
    parkedError('bd-1', 'agent failed: model quota exhausted')

    const firstBody = (await (await file('bd-1')).json()) as { errorTask: BeadsIssue }
    const prior = tracker.issues.get(firstBody.errorTask.id)
    if (prior !== undefined)
      tracker.issues.set(firstBody.errorTask.id, { ...prior, status: 'closed' })
    const secondBody = (await (await file('bd-1')).json()) as { errorTask: BeadsIssue }

    expect(tracker.created).toHaveLength(2)
    expect(secondBody.errorTask.id).not.toBe(firstBody.errorTask.id)
  })
})

describe('POST /api/repos/:repo/tasks/:id/retry', () => {
  let tracker: FakeGateTracker

  beforeEach(() => {
    tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  const deferred = (id: string) => {
    claim(id)
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(id, {
      type: 'retry.scheduled',
      attempt: 1,
      delayMs: 60_000,
      reason: 'transient harness failure',
      detail: 'rate limit exceeded',
    })
    store.append(id, { type: 'task.state', from: 'implementing', to: 'retrying' })
  }

  test('wakes a deferred retry on the runner and reports the task id', async () => {
    const retried: string[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: {
        status: async () => ({
          name: 'repo1',
          available: true,
          capacity: 1,
          running: ['bd-1'],
          startedAt: {},
          resources: {},
          tasks: {},
          autoQueue: false,
        }),
        start: async () => ({ ok: true, taskId: 'bd-1' }),
        stop: async () => ({ ok: true, taskId: 'bd-1' }),
        setWorkerOn: () => {},
        retryNow: async (id) => {
          retried.push(id)
          return { ok: true, taskId: id }
        },
        setAutoQueue: () => {},
      },
    })
    deferred('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/retry', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ taskId: 'bd-1' })
    expect(retried).toEqual(['bd-1'])
  })

  test('409s when the task is not deferring a retry', async () => {
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await app.request('/api/repos/repo1/tasks/bd-1/retry', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope/retry', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('is 501 without a runner service', async () => {
    deferred('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/retry', { method: 'POST' })
    expect(res.status).toBe(501)
  })
})

describe('POST /api/repos/:repo/tasks/:id/recheck', () => {
  let tracker: FakeGateTracker
  let forge: FakeMergePrDriver

  beforeEach(() => {
    tracker = new FakeGateTracker()
    forge = new FakeMergePrDriver()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker, forgeFor: () => forge })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  const parked = (id: string, state: 'pr_open' | 'pr_flagged' = 'pr_open') => {
    claim(id)
    store.append(id, {
      type: 'pr.created',
      url: 'https://example.com/demo/pull/7',
      number: 7,
    })
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
    ] as const) {
      store.append(id, { type: 'task.state', from: null, to })
    }
    if (state === 'pr_flagged') {
      store.append(id, { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
    }
  }

  test('settles a merged pr as done and closes the tracker issue', async () => {
    parked('bd-1')
    forge.getPr = async () => 'merged'
    const res = await app.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('done')
    expect(tracker.closed.map((c) => c.id)).toEqual(['bd-1'])
  })

  test('marks a closed pr abandoned', async () => {
    parked('bd-1')
    forge.getPr = async () => 'closed'
    const res = await app.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('abandoned')
    expect(tracker.statuses).toEqual([{ id: 'bd-1', status: 'closed' }])
  })

  test('an open pr keeps the task parked and records merge status', async () => {
    parked('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('pr_open')
    expect(store.task('bd-1')?.prMergeStatus).toBe('mergeable')
  })

  test('rechecks a flagged task too', async () => {
    parked('bd-1', 'pr_flagged')
    forge.getPr = async () => 'merged'
    const res = await app.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('done')
  })

  test('409s when the task is not parked on a pull request', async () => {
    claim('bd-1')
    const res = await app.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(409)
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/repos/repo1/tasks/nope/recheck', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('501s when the repo has no forge driver', async () => {
    const noForge = testWorkspaces(['repo1'], { trackerFor: () => tracker, forgeFor: () => null })
    const noForgeApp = createApp({ workspaces: noForge.workspaces })
    const noForgeStore = noForge.store('repo1')
    noForgeStore.append('bd-1', { type: 'task.claimed', title: 'pr work', tracker: 'beads' })
    noForgeStore.append('bd-1', {
      type: 'pr.created',
      url: 'https://example.com/demo/pull/7',
      number: 7,
    })
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
    ] as const) {
      noForgeStore.append('bd-1', { type: 'task.state', from: null, to })
    }
    const res = await noForgeApp.request('/api/repos/repo1/tasks/bd-1/recheck', { method: 'POST' })
    expect(res.status).toBe(501)
    noForge.cleanup()
  })
})

describe('POST /api/tasks/:id/stop', () => {
  beforeEach(() => {
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  const running = (id: string) => {
    claim(id)
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  }

  test('parks a running task in cancelled', async () => {
    running('bd-1')
    const res = await app.request('/api/tasks/bd-1/stop', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('cancelled')
    expect(store.task('bd-1')?.state).toBe('cancelled')
  })

  test('404s on an unknown task', async () => {
    const res = await app.request('/api/tasks/nope/stop', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('409s on an already terminal task', async () => {
    running('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'cancelled' })
    const res = await app.request('/api/tasks/bd-1/stop', { method: 'POST' })
    expect(res.status).toBe(409)
  })
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
    store.append(id, { type: 'task.state', from: 'implementing', to: state, reason: 'parked' })
  }
  const close = (id: string, reason: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    })

  test('abandons a needs_human task with the reason and closes it on the tracker', async () => {
    parked('bd-1', 'needs_human')
    const res = await close('bd-1', 'operator says done')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('abandoned')
    expect(body.task.statusReason).toBe('operator says done')
    expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'operator says done' }])
  })

  test.each(['no_pr', 'needs_human'] as const)(
    'abandons a %s task recording the reason',
    async (state) => {
      parked('bd-1', state)
      const res = await close('bd-1', 'not needed')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: ProjectedTask }
      expect(body.task.state).toBe('abandoned')
      expect(body.task.statusReason).toBe('not needed')
    },
  )

  test.each(['no_pr', 'needs_human'] as const)(
    'marks a %s task done with the reason and closes it on the tracker',
    async (state) => {
      parked('bd-1', state)
      const res = await app.request(`/api/repos/repo1/tasks/bd-1/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'already implemented elsewhere', to: 'done' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { task: ProjectedTask }
      expect(body.task.state).toBe('done')
      expect(body.task.statusReason).toBe('already implemented elsewhere')
      expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'already implemented elsewhere' }])
    },
  )

  test('rejects marking an in-flight task done', async () => {
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await app.request('/api/repos/repo1/tasks/bd-1/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'nope', to: 'done' }),
    })
    expect(res.status).toBe(409)
    expect(tracker.closed).toHaveLength(0)
  })

  test('instantly closes an in-flight task, stopping the worker and deleting the worktree', async () => {
    const stopped: string[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: {
        status: async () => ({
          name: 'repo1',
          available: true,
          capacity: 1,
          running: ['bd-1'],
          startedAt: { 'bd-1': 1720000000000 },
          resources: {},
          tasks: {},
          autoQueue: false,
        }),
        start: async () => ({ ok: true, taskId: 'bd-1' }),
        stop: async (id) => {
          stopped.push(id)
          // Mirror the real stop: a live run parks in cancelled before close.
          store.append(id, { type: 'task.state', from: 'implementing', to: 'cancelled' })
          return { ok: true, taskId: id }
        },
        setWorkerOn: () => {},
        retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
        setAutoQueue: () => {},
      },
    })
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append('bd-1', { type: 'worktree.created', path: '/tmp/wt/bd-1', branch: 'amagi/bd-1-x' })
    // The fake workspace root does not exist; give git a valid cwd to run in.
    const root = ws.workspaces.get('repo1')?.root
    if (root) mkdirSync(root, { recursive: true })

    const res = await close('bd-1', 'kill it')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(stopped).toEqual(['bd-1'])
    expect(body.task.state).toBe('abandoned')
    // The recorded worktree is dropped from the projection.
    expect(body.task.worktree).toBeNull()
    expect(body.task.branch).toBeNull()
    expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'kill it' }])
  })

  test('closing an in-flight task does not require the runner service', async () => {
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const res = await close('bd-1', 'kill it')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('abandoned')
    expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'kill it' }])
  })

  test('abandons a deferred retry, stopping the backoff and retiring the task', async () => {
    const stopped: string[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: {
        status: async () => ({
          name: 'repo1',
          available: true,
          capacity: 1,
          running: ['bd-1'],
          startedAt: {},
          resources: {},
          tasks: {},
          autoQueue: false,
        }),
        start: async () => ({ ok: true, taskId: 'bd-1' }),
        stop: async (id) => {
          stopped.push(id)
          // Mirror the real stop: a sleeping backoff parks in cancelled.
          store.append(id, { type: 'task.state', from: 'retrying', to: 'cancelled' })
          return { ok: true, taskId: id }
        },
        setWorkerOn: () => {},
        retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
        setAutoQueue: () => {},
      },
    })
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append('bd-1', {
      type: 'retry.scheduled',
      attempt: 1,
      delayMs: 60_000,
      reason: 'transient harness failure',
      detail: 'rate limit exceeded',
    })
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'retrying' })

    const res = await close('bd-1', 'give up on it')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(stopped).toEqual(['bd-1'])
    expect(body.task.state).toBe('abandoned')
    expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'give up on it' }])
  })

  test('404s on an unknown task', async () => {
    const res = await close('nope', 'x')
    expect(res.status).toBe(404)
  })

  test('409s when the task is already settled', async () => {
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'done' })
    const res = await close('bd-1', 'no longer wanted')
    expect(res.status).toBe(409)

    store.append('bd-2', {
      type: 'task.claimed',
      title: 'withdrawn',
      tracker: 'beads',
    })
    store.append('bd-2', { type: 'task.state', from: null, to: 'abandoned' })
    expect((await close('bd-2', 'already gone')).status).toBe(409)
  })

  test('rejects a missing or blank reason', async () => {
    parked('bd-1', 'needs_human')
    const missing = await app.request('/api/repos/repo1/tasks/bd-1/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(missing.status).toBe(400)
    expect(tracker.closed).toHaveLength(0)

    const blank = await close('bd-1', '   ')
    expect(blank.status).toBe(400)
    expect(tracker.closed).toHaveLength(0)
  })

  test('a tracker failure still records the abandonment', async () => {
    tracker.close = async () => {
      throw new Error('bd down')
    }
    parked('bd-1', 'no_pr')
    const res = await close('bd-1', 'wont run')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('abandoned')
    expect(body.task.statusReason).toBe('wont run')
  })

  class FakeForge implements PrDriver {
    readonly closed: { number: number; reason: string }[] = []
    closeError: Error | null = null
    async createPr(): Promise<PullRequest> {
      throw new Error('unused')
    }
    async getPr(): Promise<PrState> {
      return 'open'
    }
    async getMergeStatus() {
      return 'mergeable' as const
    }
    async getPrDiff(): Promise<string> {
      return ''
    }
    async listOpenPrs(): Promise<PrInfo[]> {
      return []
    }
    async listComments(): Promise<PrComment[]> {
      return []
    }
    async postComment(): Promise<void> {}
    async closePr(_cwd: string, number: number, reason: string): Promise<void> {
      if (this.closeError !== null) throw this.closeError
      this.closed.push({ number, reason })
    }
    async addLabel(): Promise<void> {}
    async removeLabel(): Promise<void> {}
  }

  const withForge = (forge: FakeForge) => {
    const workspace = ws.workspaces.get('repo1')
    if (workspace === null) throw new Error('workspace missing')
    workspace.forge = forge
  }

  const flagged = (id: string, number: number) => {
    claim(id)
    store.append(id, { type: 'pr.created', url: `https://github.com/x/y/pull/${number}`, number })
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
    ] as const) {
      store.append(id, { type: 'task.state', from: null, to })
    }
    store.append(id, {
      type: 'task.state',
      from: 'pr_open',
      to: 'pr_flagged',
      reason: 'this PR is pointless',
    })
  }

  test('closing a pr_flagged task closes its pull request on the forge', async () => {
    const forge = new FakeForge()
    withForge(forge)
    flagged('bd-1', 7)
    const res = await close('bd-1', 'agree, nothing to merge')
    expect(res.status).toBe(200)
    expect(forge.closed).toEqual([{ number: 7, reason: 'agree, nothing to merge' }])
    const body = (await res.json()) as { task: ProjectedTask }
    expect(body.task.state).toBe('abandoned')
    expect(body.task.statusReason).toBe('agree, nothing to merge')
    expect(tracker.closed).toEqual([{ id: 'bd-1', reason: 'agree, nothing to merge' }])
  })

  test('closing a pr_open task does not touch the pull request', async () => {
    const forge = new FakeForge()
    withForge(forge)
    claim('bd-1')
    store.append('bd-1', { type: 'pr.created', url: 'https://github.com/x/y/pull/7', number: 7 })
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
    ] as const) {
      store.append('bd-1', { type: 'task.state', from: null, to })
    }

    const res = await close('bd-1', 'abandoning anyway')
    expect(res.status).toBe(200)
    expect(forge.closed).toEqual([])
    expect(((await res.json()) as { task: ProjectedTask }).task.state).toBe('abandoned')
  })

  test('refuses to close a pr_flagged task without a forge driver', async () => {
    const workspace = ws.workspaces.get('repo1')
    if (workspace === null) throw new Error('workspace missing')
    workspace.forge = null
    flagged('bd-1', 7)
    const res = await close('bd-1', 'close it')
    expect(res.status).toBe(501)
    expect(tracker.closed).toHaveLength(0)
    expect(store.task('bd-1')?.state).toBe('pr_flagged')
  })

  test('a forge failure leaves the flagged task parked so the operator can retry', async () => {
    const forge = new FakeForge()
    forge.closeError = new Error('forge down')
    withForge(forge)
    flagged('bd-1', 7)
    const res = await close('bd-1', 'close it')
    expect(res.status).toBe(502)
    expect(store.task('bd-1')?.state).toBe('pr_flagged')
    expect(tracker.closed).toHaveLength(0)
  })
})

describe('POST /api/repos/:repo/tasks/:id/chat', () => {
  class FakeChatHarness implements Harness {
    readonly kind = 'fake'
    readonly calls: { resumeFrom: string | null; prompt: string; cwd: string }[] = []
    start(opts: AgentStartOptions): AgentProcess {
      return this.run(null, opts)
    }
    resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
      return this.run(sessionId, opts)
    }
    async listModels(): Promise<string[]> {
      return []
    }
    async listEfforts(): Promise<string[]> {
      return []
    }
    private run(resumeFrom: string | null, opts: AgentStartOptions): AgentProcess {
      this.calls.push({ resumeFrom, prompt: opts.prompt, cwd: opts.cwd })
      const queue = new AsyncQueue<AgentEvent>()
      queue.push({ kind: 'text', text: 'the answer' })
      queue.close()
      const outcome: AgentOutcome = {
        exitCode: 0,
        ok: true,
        sessionId: 'sess-1',
        summary: 'the answer',
        usage: null,
        stderr: '',
      }
      return {
        pid: -1,
        events: () => queue,
        done: Promise.resolve(outcome),
        kill: async () => {},
        model: null,
        effort: null,
      }
    }
  }

  let harness: FakeChatHarness

  beforeEach(() => {
    harness = new FakeChatHarness()
    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces, chatHarnessFor: () => harness })
  })

  const parked = (id: string) => {
    store.append(id, { type: 'task.claimed', title: 't', tracker: 'beads' })
    store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(id, { type: 'worktree.created', path: '/tmp/wt', branch: 'amagi/x' })
    store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(id, { type: 'agent.exited', role: 'implement', exitCode: 0, sessionId: 'sess-1' })
    store.append(id, {
      type: 'task.state',
      from: 'implementing',
      to: 'no_pr',
      reason: 'no changes',
    })
  }
  const chat = (id: string, message: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    })

  test('accepts a message and resumes the recorded session on the worktree', async () => {
    parked('bd-1')
    const res = await chat('bd-1', 'why no pr?')
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ taskId: 'bd-1' })
    expect(harness.calls).toEqual([{ resumeFrom: 'sess-1', prompt: 'why no pr?', cwd: '/tmp/wt' }])
    const events = store.events({ taskId: 'bd-1' })
    expect(events.some((e) => e.type === 'chat.message' && e.text === 'why no pr?')).toBe(true)
  })

  test('rejects a missing or blank message', async () => {
    parked('bd-1')
    expect((await chat('bd-1', '')).status).toBe(400)
    expect((await chat('bd-1', '   ')).status).toBe(400)
    const empty = await app.request('/api/repos/repo1/tasks/bd-1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(empty.status).toBe(400)
    expect(harness.calls).toHaveLength(0)
  })

  test('404s on an unknown task', async () => {
    const res = await chat('nope', 'hi')
    expect(res.status).toBe(404)
    expect(harness.calls).toHaveLength(0)
  })

  test('409s when the task is not a parked no_pr task', async () => {
    store.append('bd-1', { type: 'task.claimed', title: 't', tracker: 'beads' })
    const res = await chat('bd-1', 'hi')
    expect(res.status).toBe(409)
    expect(harness.calls).toHaveLength(0)
  })

  test('409s when the task has no summary to chat about', async () => {
    store.append('bd-1', { type: 'task.claimed', title: 't', tracker: 'beads' })
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'worktree.created', path: '/tmp/wt', branch: 'amagi/x' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append('bd-1', {
      type: 'agent.exited',
      role: 'implement',
      exitCode: 0,
      sessionId: 'sess-1',
    })
    store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'no_pr' })
    const res = await chat('bd-1', 'hi')
    expect(res.status).toBe(409)
    expect(harness.calls).toHaveLength(0)
  })
})

describe('runner endpoints', () => {
  const stubRunner = (over: Partial<RunServiceApi> = {}): RunServiceApi => ({
    status: async () => ({
      name: 'repo1',
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
    setWorkerOn: () => {},
    retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
    setAutoQueue: () => {},
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

  test('GET /api/runner reports availability, capacity and per-task resources', async () => {
    app = createApp({
      workspaces: ws.workspaces,
      runner: stubRunner({
        status: async () => ({
          name: 'repo1',
          available: false,
          capacity: 1,
          running: ['bd-1'],
          startedAt: { 'bd-1': 1720000000000 },
          resources: { 'bd-1': { processes: 3, rssBytes: 1048576, cpuMs: 4200 } },
          tasks: {},
          autoQueue: false,
        }),
      }),
    })
    const res = await app.request('/api/runner')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      name: 'repo1',
      available: false,
      capacity: 1,
      running: ['bd-1'],
      startedAt: { 'bd-1': 1720000000000 },
      resources: { 'bd-1': { processes: 3, rssBytes: 1048576, cpuMs: 4200 } },
      tasks: {},
      autoQueue: false,
    })
  })

  test('GET /api/runner merges background worker activity when present', async () => {
    app = createApp({
      workspaces: ws.workspaces,
      runner: stubRunner(),
      workers: () => [
        {
          repo: 'repo1',
          name: 'mention-watcher',
          lastRunAt: 1720000000000,
          ok: true,
          error: null,
          counters: [
            { label: 'scanned', value: 2 },
            { label: 'responded', value: 1 },
          ],
          detail: 'scanned 2 PRs, responded to 1 mention(s)',
          runs: 1,
          successes: 1,
          failures: 0,
          nextRunAt: 1720000300000,
          intervalMs: 300000,
          status: 'active',
        },
      ],
    })
    const res = await app.request('/api/runner')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { workers?: unknown }
    expect(body.workers).toEqual([
      {
        repo: 'repo1',
        name: 'mention-watcher',
        lastRunAt: 1720000000000,
        ok: true,
        error: null,
        counters: [
          { label: 'scanned', value: 2 },
          { label: 'responded', value: 1 },
        ],
        detail: 'scanned 2 PRs, responded to 1 mention(s)',
        runs: 1,
        successes: 1,
        failures: 0,
        nextRunAt: 1720000300000,
        intervalMs: 300000,
        status: 'active',
      },
    ])
  })

  test('GET /api/runner merges a live foreground worker into the slots', async () => {
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore' })
    try {
      app = createApp({
        workspaces: ws.workspaces,
        runner: stubRunner(),
        liveRuns: () => [
          {
            pid: proc.pid,
            repoKey: 'repo1',
            repoName: 'repo1',
            taskId: 'bd-9',
            title: 'just-run worker',
            harness: 'claude',
            model: 'sonnet',
            effort: null,
            startedAt: 1720000000000,
          },
        ],
      })
      const res = await app.request('/api/runner')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        running: string[]
        startedAt: Record<string, number>
        tasks: Record<string, unknown>
        resources: Record<string, unknown>
      }
      expect(body.running).toEqual(['bd-9'])
      expect(body.startedAt['bd-9']).toBe(1720000000000)
      expect(body.tasks['bd-9']).toEqual({
        title: 'just-run worker',
        harness: 'claude',
        model: 'sonnet',
        effort: null,
      })
      expect(body.resources['bd-9']).toBeDefined()
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
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

  test('POST /api/runs forwards worker and model/effort overrides', async () => {
    const received: { taskId: string | undefined; opts: RunOptions | undefined }[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: stubRunner({
        start: async (taskId, opts) => {
          received.push({ taskId, opts })
          return { ok: true, taskId: 'bd-1' }
        },
      }),
    })
    const res = await post(
      '/api/runs',
      '{"taskId":"bd-1","workerId":"w-fast","model":"gpt-5.6-luna","effort":"high"}',
    )
    expect(res.status).toBe(201)
    expect(received).toEqual([
      { taskId: 'bd-1', opts: { workerId: 'w-fast', model: 'gpt-5.6-luna', effort: 'high' } },
    ])
  })

  test('POST /api/runs sends no opts when the body omits them', async () => {
    const received: { taskId: string | undefined; opts: RunOptions | undefined }[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: stubRunner({
        start: async (taskId, opts) => {
          received.push({ taskId, opts })
          return { ok: true, taskId: 'bd-1' }
        },
      }),
    })
    expect((await post('/api/runs', '{}')).status).toBe(201)
    expect(received).toEqual([{ taskId: undefined, opts: {} }])
  })

  test('GET /api/runner/options lists fleet workers and the default worker', async () => {
    app = createApp({ workspaces: ws.workspaces, runner: stubRunner(), runnerRepo: 'repo1' })
    const res = await app.request('/api/runner/options')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      harnesses: { name: string; workerId: string; kind: string }[]
      default: string | null
    }
    const workers = ws.workspaces.get('repo1')?.config.worker ?? []
    expect(body.harnesses).toEqual(
      workers.map((worker) => ({
        name: worker.name,
        workerId: worker.id,
        kind: worker.kind,
        ...(worker.model === undefined ? {} : { model: worker.model }),
        ...(worker.effort === undefined ? {} : { effort: worker.effort }),
      })),
    )
    expect(body.default).toBe(workers.find((worker) => worker.enabled)?.id ?? null)
  })

  test('GET /api/runner/options is empty without a runner', async () => {
    const res = await app.request('/api/runner/options')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ harnesses: [], models: {}, efforts: {}, default: null })
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

describe('repo settings endpoints', () => {
  const patch = (repo: string, body: string) =>
    app.request(`/api/repos/${repo}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body,
    })

  beforeEach(() => {
    ws = testWorkspaces(['repo1', 'repo2'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
  })

  test('GET returns the auto-queue state and stale maxParallel notice flag', async () => {
    const res = await app.request('/api/repos/repo1/settings')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ autoQueue: false, staleMaxParallel: false })
  })

  test('PATCH persists auto-queue and updates the workspace config', async () => {
    const res = await patch('repo1', '{"autoQueue":true}')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ autoQueue: true })
    expect(await (await app.request('/api/repos/repo1/settings')).json()).toEqual({
      autoQueue: true,
      staleMaxParallel: false,
    })
    const entry = ws.workspaces.list().find((e) => e.key === 'repo1')
    if (entry === undefined) throw new Error('repo1 missing from registry')
    expect(loadConfig(entry.path).config.loop.autoQueue).toBe(true)
  })

  test('PATCH persists the auto-queue toggle and applies it to the served runner', async () => {
    const applied: boolean[] = []
    app = createApp({
      workspaces: ws.workspaces,
      runner: {
        status: async () => ({
          name: 'repo1',
          available: true,
          capacity: 1,
          running: [],
          resources: {},
          startedAt: {},
          tasks: {},
          autoQueue: true,
        }),
        start: async () => ({ ok: true, taskId: 'bd-1' }),
        stop: async () => ({ ok: true, taskId: 'bd-1' }),
        setWorkerOn: () => {},
        setAutoQueue: (enabled) => applied.push(enabled),
        retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
      },
      runnerRepo: 'repo1',
    })
    expect((await patch('repo1', '{"autoQueue":true}')).status).toBe(200)
    expect(applied).toEqual([true])
    expect(await (await app.request('/api/repos/repo1/settings')).json()).toEqual({
      autoQueue: true,
      staleMaxParallel: false,
    })
    const entry = ws.workspaces.list().find((e) => e.key === 'repo1')
    if (entry === undefined) throw new Error('repo1 missing from registry')
    expect(loadConfig(entry.path).config.loop.autoQueue).toBe(true)
    ws.workspaces.updateParticipation('repo1', { workers: false })
    expect((await patch('repo1', '{"autoQueue":true}')).status).toBe(200)
    expect(applied).toEqual([true, false])
    ws.workspaces.updateParticipation('repo1', { workers: true })
    expect((await patch('repo1', '{"autoQueue":true}')).status).toBe(200)
    expect(applied).toEqual([true, false, true])
    // the toggle only reaches the runner bound to this repo
    expect((await patch('repo2', '{"autoQueue":false}')).status).toBe(200)
    expect(applied).toEqual([true, false, true])
  })

  test('PATCH rejects an empty body', async () => {
    expect((await patch('repo1', '{}')).status).toBe(400)
  })

  test('PATCH rejects unknown settings instead of persisting a worker count', async () => {
    app = createApp({
      workspaces: ws.workspaces,
      runner: {
        status: async () => ({
          name: 'repo1',
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
        setWorkerOn: () => {},
        retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
        setAutoQueue: () => {},
      },
      runnerRepo: 'repo1',
    })
    expect((await patch('repo1', '{"maxParallel":3}')).status).toBe(400)
  })

  test('404s for an unknown repo', async () => {
    expect((await app.request('/api/repos/nope/settings')).status).toBe(404)
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
    const body = (await res.json()) as ProjectedQuestion[]
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
    const body = (await res.json()) as { question: ProjectedQuestion }

    expect(tracker.opened).toHaveLength(1)
    expect(tracker.opened[0]?.id).toBe(body.question.id)
    expect(tracker.opened[0]?.text).toBe('which registry?')
    expect(store.question(body.question.id)?.gateRef).toBe('gate-7')
  })

  test('answering resolves the gate', async () => {
    claim('bd-1')
    implementing('bd-1')
    const asked = await ask('bd-1', 'which registry?')
    const q = ((await asked.json()) as { question: ProjectedQuestion }).question

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

describe('POST /api/repos/:repo/tasks/:id/git-requests', () => {
  let repo: string
  let wt: string
  const branch = 'amagi/bd-1-do-something'

  const git = (cwd: string, args: string[]) => {
    const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'amagi-git-request-repo-'))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    writeFileSync(join(repo, 'README.md'), '# demo\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'init'])
    wt = mkdtempSync(join(tmpdir(), 'amagi-git-request-wt-'))
    git(repo, ['worktree', 'add', '-b', branch, wt, 'main'])

    ws = testWorkspaces(['repo1'])
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    store.append('bd-1', { type: 'task.claimed', title: 'do something', tracker: 'beads' })
    store.append('bd-1', { type: 'worktree.created', path: wt, branch })
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  })

  afterEach(() => {
    ws.cleanup()
    rmSync(repo, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  })

  const request = (id: string, verb: unknown, token?: string) =>
    app.request(`/api/repos/repo1/tasks/${id}/git-requests`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'X-Amagi-Token': token }),
      },
      body: JSON.stringify({ verb }),
    })

  test('commits the worktree and returns the sha', async () => {
    writeFileSync(join(wt, 'hello.txt'), 'hi\n')
    const res = await request('bd-1', 'commit', store.token('bd-1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { verb: string; sha: string }
    expect(body.verb).toBe('commit')
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/)
    const created = store.events({ taskId: 'bd-1' }).find((e) => e.type === 'commit.created')
    expect(created?.type === 'commit.created' ? created.sha : null).toBe(body.sha)
    expect(git(wt, ['rev-parse', 'HEAD']).stdout.trim()).toBe(body.sha)
  })

  test('rejects an unknown verb as a 400 before any git write', async () => {
    writeFileSync(join(wt, 'hello.txt'), 'hi\n')
    const res = await request('bd-1', 'push', store.token('bd-1'))
    expect(res.status).toBe(400)
    expect(git(wt, ['status', '--porcelain']).stdout.trim()).not.toBe('')
  })

  test('a missing token is a 401', async () => {
    const res = await request('bd-1', 'commit')
    expect(res.status).toBe(401)
  })

  test('an unknown task is a 404', async () => {
    const res = await request('nope', 'commit', 'x')
    expect(res.status).toBe(404)
  })

  test('a clean worktree fails with the git error', async () => {
    const res = await request('bd-1', 'commit', store.token('bd-1'))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('nothing to commit')
  })
})

describe('POST /api/repos/:repo/run', () => {
  test('dispatches the named worker through the runner service', async () => {
    const received: { taskId: string | undefined; opts: RunOptions | undefined }[] = []
    ws = testWorkspaces(['repo1'])
    app = createApp({
      workspaces: ws.workspaces,
      runnerRepo: 'repo1',
      runner: {
        status: async () => ({
          name: 'repo1',
          available: true,
          capacity: 1,
          running: [],
          startedAt: {},
          resources: {},
          tasks: {},
          autoQueue: false,
        }),
        start: async (taskId, opts) => {
          received.push({ taskId, opts })
          return { ok: true, taskId: 'bd-1' }
        },
        stop: async () => ({ ok: true, taskId: 'bd-1' }),
        retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
        setWorkerOn: () => {},
        setAutoQueue: () => {},
      },
    })
    const res = await app.request('/api/repos/repo1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"workerId":"w-1"}',
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ repo: 'repo1', taskId: 'bd-1', started: true })
    expect(received).toEqual([{ taskId: undefined, opts: { workerId: 'w-1' } }])
  })

  test('404s for an unknown repo', async () => {
    ws = testWorkspaces(['repo1'])
    app = createApp({ workspaces: ws.workspaces })
    expect(
      (
        await app.request('/api/repos/nope/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404)
  })
})

describe('POST /api/repos/:repo/triage', () => {
  test('starts a triage pass in the background for the repo', async () => {
    const tracker = new FakeGateTracker()
    ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
    store = ws.store('repo1')
    app = createApp({ workspaces: ws.workspaces })
    const res = await app.request('/api/repos/repo1/triage', { method: 'POST' })
    expect(res.status).toBe(202)
    await Bun.sleep(20)
    // the fake tracker is not triage-capable, so the pass ends without a claim
    expect(tracker.released).toEqual([])
  })

  test('404s for an unknown repo', async () => {
    ws = testWorkspaces(['repo1'])
    app = createApp({ workspaces: ws.workspaces })
    expect((await app.request('/api/repos/nope/triage', { method: 'POST' })).status).toBe(404)
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
  const rows: ProjectedTask[] = await tasks.json()
  expect(rows[0]?.id).toBe('bd-1')

  const detail = await client.api.repos[':repo'].tasks[':id'].$get({
    param: { repo: 'repo1', id: 'bd-1' },
  })
  if (detail.status !== 200) throw new Error('expected 200')
  const body: { task: ProjectedTask; questions: ProjectedQuestion[] } = await detail.json()
  expect(body.task.title).toBe('work on bd-1')
})
