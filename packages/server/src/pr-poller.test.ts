import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  type CreatePrOptions,
  type CreateTrackerTask,
  DONE_LABEL,
  exec,
  execOk,
  type GateRef,
  type MergeStatus,
  openDatabase,
  PRIMARY_FORGE,
  type PrComment,
  type PrDriver,
  type PrForge,
  type PrState,
  type PullRequest,
  type Question,
  REWORK_LABEL,
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
  labels: string[] = []
  mergeStatus: MergeStatus = 'conflicted'
  readonly calls: number[] = []
  readonly deleted: { remote: string; branch: string }[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    return { url: 'https://example.com/demo/pull/7', number: 7 }
  }
  async getPr(_cwd: string, number: number): Promise<PrState> {
    this.calls.push(number)
    return this.state
  }
  async getPrLabels(_cwd: string, _number: number): Promise<string[]> {
    return this.labels
  }
  async listOpenPrs(_cwd: string): Promise<never[]> {
    return []
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return this.mergeStatus
  }
  async getPrDiff(_cwd: string, _number: number): Promise<string> {
    return ''
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
  async closePr(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async deleteBranch(_cwd: string, remote: string, branch: string): Promise<void> {
    this.deleted.push({ remote, branch })
  }
}

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  readonly closed: { id: string; reason?: string }[] = []
  readonly statuses: { id: string; status: TrackerStatus }[] = []
  readonly comments: { id: string; body: string }[] = []
  readonly released: string[] = []

  async ready(): Promise<TrackerTask[]> {
    return []
  }
  async claim(): Promise<TrackerTask | null> {
    return null
  }
  readonly open = new Set<string>()

  async get(id: string): Promise<TrackerTask | null> {
    if (!this.open.has(id)) return null
    return { id, title: id, description: '', status: 'open', priority: null, type: null, url: null }
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
  async comment(id: string, body: string): Promise<void> {
    this.comments.push({ id, body })
  }
  async setStatus(id: string, status: TrackerStatus): Promise<void> {
    this.statuses.push({ id, status })
  }
  async release(id: string): Promise<void> {
    this.released.push(id)
  }
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
const openPr = (store: Store, prNumber = 7, worktree = '/wt/bd-1'): void => {
  store.append('bd-1', { type: 'task.claimed', title: 'pr work', tracker: 'beads' })
  store.append('bd-1', { type: 'worktree.created', path: worktree, branch: 'amagi/bd-1-pr-work' })
  store.append('bd-1', {
    type: 'pr.created',
    url: 'https://example.com/demo/pull/7',
    number: prNumber,
  })
  for (const to of ['worktree_ready', 'implementing', 'checks', 'committed', 'pr_open'] as const) {
    store.append('bd-1', { type: 'task.state', from: null, to })
  }
}

/** Routes every PR to `driver` on the origin remote. */
const on =
  (driver: PrDriver): ((prUrl: string | null) => PrForge) =>
  () => ({
    key: PRIMARY_FORGE,
    config: Config.parse({ repo: { baseBranch: 'main', worktreeRoot: '/wt' } }),
    driver,
  })

const pollers: ReturnType<typeof startPrPoller>[] = []
const tmpDirs: string[] = []

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repo with the task's branch checked out in a worktree, as a runner leaves it. */
async function repoWithWorktree(): Promise<{ repo: string; worktree: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'amagi-repo-'))
  const wtRoot = mkdtempSync(join(tmpdir(), 'amagi-wt-'))
  tmpDirs.push(repo, wtRoot)
  const git = (args: string[], cwd = repo) => execOk(exec, ['git', ...args], { cwd })
  await git(['init', '-q', '-b', 'main', '.'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.com'])
  writeFileSync(join(repo, 'README.md'), '# test\n')
  await git(['add', '.'])
  await git(['commit', '-q', '-m', 'init'])
  const worktree = join(wtRoot, 'bd-1')
  await git(['worktree', 'add', '-q', '-b', 'amagi/bd-1-pr-work', worktree])
  return { repo, worktree }
}

test('a merged pr settles the task as done and closes the tracker issue', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'merged'
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(forge.calls).toContain(7)
  expect(store.task('bd-1')?.state).toBe('done')
  expect(store.tasks({ states: ['pr_open'] })).toHaveLength(0)
  expect(tracker.closed.map((c) => c.id)).toEqual(['bd-1'])
  expect(tracker.closed[0]?.reason).toBe('PR merged')
})

test('a merged pr closes the error tasks filed against it', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  store.append('bd-1', { type: 'retry.filed_as_error', errorTaskId: 'bd-err', reason: 'boom' })
  store.append('bd-1', { type: 'retry.filed_as_error', errorTaskId: 'bd-gone', reason: 'old' })
  const forge = new FakePr()
  forge.state = 'merged'
  const tracker = new FakeTracker()
  tracker.open.add('bd-err')

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(tracker.closed).toEqual([
    { id: 'bd-1', reason: 'PR merged' },
    { id: 'bd-err', reason: 'bd-1 done' },
  ])
})

test('a closed pr settles the task as abandoned and closes the tracker issue', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('abandoned')
  expect(tracker.statuses).toEqual([{ id: 'bd-1', status: 'closed' }])
})

test('a pr closed with the done label settles the task as done', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  store.append('bd-1', { type: 'retry.filed_as_error', errorTaskId: 'bd-err', reason: 'boom' })
  const forge = new FakePr()
  forge.state = 'closed'
  forge.labels = ['amagi', DONE_LABEL]
  const tracker = new FakeTracker()
  tracker.open.add('bd-err')

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('done')
  expect(tracker.closed).toEqual([
    { id: 'bd-1', reason: `PR closed with ${DONE_LABEL}` },
    { id: 'bd-err', reason: 'bd-1 done' },
  ])
  expect(forge.deleted).toEqual([{ remote: 'origin', branch: 'amagi/bd-1-pr-work' }])
})

test('a pr closed with the rework label starts a fresh attempt', async () => {
  const { repo, worktree } = await repoWithWorktree()
  const store = new Store(openDatabase(':memory:'))
  openPr(store, 7, worktree)
  const forge = new FakePr()
  forge.state = 'closed'
  forge.labels = [REWORK_LABEL]
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: repo, intervalMs: 10 }))
  await Bun.sleep(200)

  const task = store.task('bd-1')
  expect(task?.state).toBe('claimed')
  expect(task?.attempt).toBe(2)
  expect(task?.prNumber).toBeNull()
  expect(existsSync(worktree)).toBe(false)
  expect(forge.deleted).toEqual([{ remote: 'origin', branch: 'amagi/bd-1-pr-work' }])
  expect(tracker.comments.map((c) => c.id)).toEqual(['bd-1'])
  expect(tracker.comments[0]?.body).toContain('https://example.com/demo/pull/7')
  expect(tracker.released).toEqual(['bd-1'])
  expect(tracker.closed).toEqual([])
  expect(tracker.statuses).toEqual([])
})

test('a pr closed with both outcome labels is abandoned', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'
  forge.labels = [DONE_LABEL, REWORK_LABEL]
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('abandoned')
  expect(tracker.released).toEqual([])
})

test('a closed pr whose labels cannot be read stays unsettled', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'
  forge.getPrLabels = async () => {
    throw new Error('forge down')
  }
  const tracker = new FakeTracker()

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(tracker.statuses).toEqual([])
})

test('an open pr keeps the task in pr_open', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const tracker = new FakeTracker()

  pollers.push(
    startPrPoller({
      store,
      forgeFor: on(new FakePr()),
      tracker,
      cwd: '/repo',
      intervalMs: 10,
    }),
  )
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(tracker.closed).toEqual([])
  expect(tracker.statuses).toEqual([])
})

test('a resolved conflict returns the task to pr_open', async () => {
  for (const from of ['pr_merge_conflict', 'pr_conflict_fixing'] as const) {
    const store = new Store(openDatabase(':memory:'))
    openPr(store)
    store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_merge_conflict' })
    if (from === 'pr_conflict_fixing') {
      store.append('bd-1', { type: 'task.state', from: 'pr_merge_conflict', to: from })
    }
    const forge = new FakePr()
    forge.mergeStatus = 'mergeable'
    pollers.push(
      startPrPoller({
        store,
        forgeFor: on(forge),
        tracker: new FakeTracker(),
        cwd: '/repo',
        intervalMs: 10,
      }),
    )
    await Bun.sleep(40)

    expect(store.task('bd-1')?.state).toBe('pr_open')
    expect(store.task('bd-1')?.prMergeStatus).toBe('mergeable')
  }
})

test('an open pr records its merge status for the pr_open task', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const tracker = new FakeTracker()
  const forge = new FakePr()
  forge.mergeStatus = 'conflicted'

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
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

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
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

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(store.task('bd-1')?.prMergeStatus).toBeNull()
})

test('a merged pr deletes its branch from the remote', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'merged'

  pollers.push(
    startPrPoller({
      store,
      forgeFor: on(forge),
      tracker: new FakeTracker(),
      cwd: '/repo',
      intervalMs: 10,
    }),
  )
  await Bun.sleep(40)

  expect(forge.deleted).toEqual([{ remote: 'origin', branch: 'amagi/bd-1-pr-work' }])
})

test('a closed pr deletes its branch once the tracker issue is closed', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'

  pollers.push(
    startPrPoller({
      store,
      forgeFor: on(forge),
      tracker: new FakeTracker(),
      cwd: '/repo',
      intervalMs: 10,
    }),
  )
  await Bun.sleep(40)

  expect(forge.deleted).toEqual([{ remote: 'origin', branch: 'amagi/bd-1-pr-work' }])
})

test('a closed pr keeps its branch when the tracker issue could not be closed', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'
  const tracker = new FakeTracker()
  tracker.setStatus = async () => {
    throw new Error('tracker down')
  }

  pollers.push(startPrPoller({ store, forgeFor: on(forge), tracker, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('abandoned')
  expect(forge.deleted).toEqual([])
})

test('an open pr keeps its branch', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()

  pollers.push(
    startPrPoller({
      store,
      forgeFor: on(forge),
      tracker: new FakeTracker(),
      cwd: '/repo',
      intervalMs: 10,
    }),
  )
  await Bun.sleep(40)

  expect(forge.deleted).toEqual([])
})
