import { afterEach, expect, test } from 'bun:test'
import {
  type CreatePrOptions,
  openDatabase,
  type PrComment,
  type PrDriver,
  type PrState,
  type PullRequest,
  Store,
} from '@amagi/core'
import { startPrPoller } from './pr-poller.ts'

class FakePr implements PrDriver {
  state: PrState = 'open'
  readonly calls: number[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    return { url: 'https://example.com/demo/pull/7', number: 7 }
  }
  async getPr(_cwd: string, number: number): Promise<PrState> {
    this.calls.push(number)
    return this.state
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
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

test('a merged pr settles the task as done', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'merged'

  pollers.push(startPrPoller({ store, forge, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(forge.calls).toContain(7)
  expect(store.task('bd-1')?.state).toBe('done')
  expect(store.tasks({ states: ['pr_open'] })).toHaveLength(0)
})

test('a closed pr settles the task as abandoned', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)
  const forge = new FakePr()
  forge.state = 'closed'

  pollers.push(startPrPoller({ store, forge, cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('abandoned')
})

test('an open pr keeps the task in pr_open', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPr(store)

  pollers.push(startPrPoller({ store, forge: new FakePr(), cwd: '/repo', intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.task('bd-1')?.state).toBe('pr_open')
})
