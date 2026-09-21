import { afterEach, expect, test } from 'bun:test'
import {
  type CreateTrackerTask,
  type GateRef,
  openDatabase,
  type Question,
  Store,
  type Tracker,
  type TrackerCapabilities,
  type TrackerStatus,
  type TrackerTask,
  type UpdateTrackerTask,
} from '@amagi/core'
import { startStallWatcher } from './stall-watcher.ts'

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  released: string[] = []

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
  }
  async close(): Promise<void> {}
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'gate-7', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return true
  }
  async resolveGate(): Promise<void> {}
}

const watchers: ReturnType<typeof startStallWatcher>[] = []

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.stop()
})

const implementing = (store: Store, id = 'bd-1') => {
  store.append(id, { type: 'task.claimed', title: 'stall work', tracker: 'beads' })
  for (const to of ['worktree_ready', 'implementing'] as const) {
    store.append(id, { type: 'task.state', from: null, to })
  }
}

test('recovers a stalled implementing task, keeping its worktree, and reports it', async () => {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  implementing(store)
  store.append('bd-1', { type: 'worktree.created', path: '/tmp/wt/x', branch: 'amagi/bd-1-x' })
  store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-1')

  const watcher = startStallWatcher({
    repo: 'repo1',
    store,
    tracker,
    timeoutMs: 60_000,
    intervalMs: 10,
  })
  watchers.push(watcher)
  await Bun.sleep(40)

  expect(tracker.released).toEqual(['bd-1'])
  const task = store.task('bd-1')
  expect(task?.state).toBe('claimed')
  expect(task?.worktree).toBe('/tmp/wt/x')
  expect(task?.statusReason).toContain('recovered by stall watcher')
  expect(watcher.activity().detail).toBe('recovered 1 stalled task')
  expect(watcher.activity().ok).toBe(true)
})

test('a task with a fresh worker heartbeat is left alone', async () => {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  implementing(store)
  store.heartbeat('bd-1')
  store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-1')

  watchers.push(
    startStallWatcher({ repo: 'repo1', store, tracker, timeoutMs: 60_000, intervalMs: 10 }),
  )
  await Bun.sleep(40)

  expect(tracker.released).toEqual([])
  expect(store.task('bd-1')?.state).toBe('implementing')
})

test('a pr_open task is not recovered: no worker drives it', async () => {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  implementing(store)
  store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'checks' })
  store.append('bd-1', { type: 'task.state', from: 'checks', to: 'committed' })
  store.append('bd-1', { type: 'task.state', from: 'committed', to: 'pr_open' })
  store.append('bd-1', { type: 'pr.created', url: 'https://example.test/pr/1', number: 1 })
  store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-1')

  watchers.push(
    startStallWatcher({ repo: 'repo1', store, tracker, timeoutMs: 60_000, intervalMs: 10 }),
  )
  await Bun.sleep(40)

  expect(tracker.released).toEqual([])
  expect(store.task('bd-1')?.state).toBe('pr_open')
})
