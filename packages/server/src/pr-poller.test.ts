import { afterEach, expect, test } from 'bun:test'
import {
  type CreatePrOptions,
  type CreateTrackerTask,
  type GateRef,
  type OpenPr,
  openDatabase,
  type PrComment,
  type PrDriver,
  type PrState,
  type PullRequest,
  type Question,
  Store,
  type Tracker,
  type TrackerCapabilities,
  type TrackerStatus,
  type TrackerTask,
  type UpdateTrackerTask,
} from '@amagi/core'
import { startPrPoller } from './pr-poller.ts'

class FakePr implements PrDriver {
  state: PrState = 'open'
  mergeStatus = 'conflicted' as const
  readonly calls: number[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    return { url: 'https://example.com/demo/pull/7', number: 7 }
  }
  async getPr(_cwd: string, number: number): Promise<PrState> {
    this.calls.push(number)
    return this.state
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return this.mergeStatus
  }
  async listOpenPrs(_cwd: string): Promise<OpenPr[]> {
    return []
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
}

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  readonly closed: { id: string; reason?: string }[] = []
  readonly statuses: { id: string; status: TrackerStatus }[] = []

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
  async release(): Promise<void> {}
  async close(id: string, reason?: string): Promise<void> {
    this.closed.push(reason === undefined ? { id } : { id, reason })
  }
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'gate-7', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return false
  }
  async resolveGate(): Promise<void> {}
}

/** Claims a task and drives it to pr_open with a recorded pr number. */
const openPr = (store: Store, prNumber = 7): void => {
  store.append('bd-1', { type: 'task.claimed', title: 'pr work', tracker: 'beads' })
  store.append('bd-1', {
    type: 'pr.created',
    url: 'https://example.com/demo/pull/7',
    number: prNumber,
  })
  for (const to of ['worktree_ready', 'implementing', 'checks', 'committed', 'pr_open'] as const) {
    store.append('bd-1', { type: 'task.state', from: null, to })
  }
}

const pollers: ReturnType<typeof startPrPoller>[] = []

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
})

test('a merged pr settles the task as done and closes the tracker issue', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'merged'
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forge, tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(forge.calls).toContain(7)
  expect(store.task('bd-1')?.state).toBe('done')
  expect(store.tasks({ states: ['pr_open'] })).toHaveLength(0)
  expect(tracker.closed.map((c) => c.id)).toEqual(['bd-1'])
  expect(tracker.closed[0]?.reason).toBe('PR merged')
})

test('a closed pr settles the task as abandoned and closes the tracker issue', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forge, tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('abandoned')
  expect(tracker.statuses).toEqual([{ id: 'bd-1', status: 'closed' }])
})

test('an open pr keeps the task in pr_open', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forge: new FakePr(), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(tracker.closed).toEqual([])
  expect(tracker.statuses).toEqual([])
})

test('an open pr records its merge status for the pr_open task', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const tracker = new FakeTracker()
  const forge = new FakePr()
  forge.mergeStatus = 'conflicted'

  pollers.push(startPrPoller({ store, forge, tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.prMergeStatus).toBe('conflicted')
})

test('a merged pr settles a flagged task as done', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
  const forge = new FakePr()
  forge.state = 'merged'
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forge, tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('done')
  expect(tracker.closed.map((c) => c.id)).toEqual(['bd-1'])
})

test('an unresolvable merge status keeps the task in pr_open without settling it', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const tracker = new FakeTracker()
  const forge = new FakePr()
  forge.getMergeStatus = async () => {
    throw new Error('forge down')
  }

  pollers.push(startPrPoller({ store, forge, tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(store.task('bd-1')?.prMergeStatus).toBeNull()
})
