import { afterEach, expect, test } from 'bun:test'
import {
  type GateRef,
  openDatabase,
  type Question,
  type QuestionRow,
  Store,
  type Tracker,
  type TrackerStatus,
  type TrackerTask,
} from '@amagi/core'
import { createApp } from './app.ts'
import { startGatePoller } from './gate-poller.ts'
import { testWorkspaces } from './test-util.ts'

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  private resolved = new Set<string>()

  setResolved(id: string): void {
    this.resolved.add(id)
  }

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
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'gate-7', advisory: false }
  }
  async gateResolved(ref: GateRef): Promise<boolean> {
    return this.resolved.has(ref.id)
  }
  async resolveGate(): Promise<void> {}
}

const claim = (store: Store) =>
  store.append('bd-1', { type: 'task.claimed', title: 'gate work', tracker: 'beads' })

const implementing = (store: Store) => {
  for (const to of ['worktree_ready', 'implementing'] as const) {
    store.append('bd-1', { type: 'task.state', from: null, to })
  }
}

const pollers: ReturnType<typeof startGatePoller>[] = []

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
})

test('an unresolved gate keeps the question open', async () => {
  const store = new Store(openDatabase(':memory:'))
  claim(store)
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which?',
    options: [],
    gateRef: 'gate-7',
  })

  pollers.push(startGatePoller({ store, tracker: new FakeTracker(), intervalMs: 10 }))
  await Bun.sleep(40)

  expect(store.question('q1')?.resolvedAt).toBeNull()
  expect(store.openQuestions()).toHaveLength(1)
})

test('a gate closed with bd alone resolves the question', async () => {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  claim(store)
  implementing(store)
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which?',
    options: [],
    gateRef: 'gate-7',
  })

  pollers.push(startGatePoller({ store, tracker, intervalMs: 10 }))
  await Bun.sleep(40)
  tracker.setResolved('gate-7')
  await Bun.sleep(40)

  const question = store.question('q1')
  expect(question?.answer).toBe('')
  expect(question?.answeredVia).toBe('gate')
  expect(store.task('bd-1')?.state).toBe('implementing')
  expect(store.openQuestions()).toHaveLength(0)
})

test('a gate resolved after the question timed out still unblocks the parked runner', async () => {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  claim(store)
  implementing(store)
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which?',
    options: [],
    gateRef: 'gate-7',
  })
  store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'awaiting_answer' })
  store.append('bd-1', { type: 'question.timedout', questionId: 'q1' })
  expect(store.unansweredQuestions()).toHaveLength(1)

  pollers.push(startGatePoller({ store, tracker, intervalMs: 10 }))
  await Bun.sleep(40)
  tracker.setResolved('gate-7')
  await Bun.sleep(40)

  expect(store.question('q1')?.answer).toBe('')
  expect(store.question('q1')?.answeredVia).toBe('gate')
  expect(store.task('bd-1')?.state).toBe('implementing')
  expect(store.unansweredQuestions()).toHaveLength(0)
})

test('await unblocks within one poll interval after the gate resolves', async () => {
  const tracker = new FakeTracker()
  const ws = testWorkspaces(['repo1'], { trackerFor: () => tracker })
  const store = ws.store('repo1')
  claim(store)
  implementing(store)
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which?',
    options: [],
    gateRef: 'gate-7',
  })

  const app = createApp({ workspaces: ws.workspaces })
  pollers.push(startGatePoller({ store, tracker, intervalMs: 10 }))

  const token = store.token('bd-1')
  const pending = app.request('/api/repos/repo1/tasks/bd-1/questions/q1/await', {
    headers: { 'X-Amagi-Token': token },
  })
  await Bun.sleep(20)
  tracker.setResolved('gate-7')

  const res = await pending
  expect(res.status).toBe(200)
  const body = (await res.json()) as { question: QuestionRow }
  expect(body.question.answer).toBe('')
  expect(body.question.answeredVia).toBe('gate')
  ws.cleanup()
})
