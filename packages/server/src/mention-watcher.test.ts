import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  type CreatePrOptions,
  type Exec,
  type Harness,
  openDatabase,
  type PrComment,
  type PrDriver,
  type PrInfo,
  type PrState,
  type PullRequest,
  Store,
  type Tracker,
} from '@amagi/core'
import { startMentionWatcher } from './mention-watcher.ts'

const config = (): Config =>
  Config.parse({ repo: { baseBranch: 'main' }, checks: { commands: [] } })

const prInfo = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  body: '',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: 'deadbeef',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: [],
  ...over,
})

class FakePr implements PrDriver {
  comments: PrComment[] = []
  prs: PrInfo[] = []
  readonly posted: string[] = []
  listCalls = 0
  /** Throw on the nth postComment call (1-based) to simulate a failed response. */
  failPost = 0

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    throw new Error('unused')
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async listOpenPrs(_cwd: string): Promise<PrInfo[]> {
    return this.prs
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async getPrDiff(_cwd: string, _number: number): Promise<string> {
    throw new Error('unused')
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    this.listCalls++
    return this.comments
  }
  async postComment(_cwd: string, _number: number, body: string): Promise<void> {
    if (this.failPost > 0) {
      this.failPost--
      throw new Error('post failed')
    }
    this.posted.push(body)
  }
  async closePr(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async deleteBranch(): Promise<void> {}
}

function fakeHarness(summary = 'ambiguous'): Harness {
  const process = {
    pid: -1,
    events: async function* () {},
    done: Promise.resolve({
      exitCode: 0,
      ok: true,
      sessionId: null,
      summary,
      usage: null,
      stderr: '',
    }),
    kill: async () => {},
    model: null,
    effort: null,
  }
  return {
    kind: 'fake',
    start: () => process,
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

let cacheDir: string
const watchers: ReturnType<typeof startMentionWatcher>[] = []

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'amagi-mention-watch-'))
  process.env.XDG_CACHE_HOME = cacheDir
})

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop()
  delete process.env.XDG_CACHE_HOME
  rmSync(cacheDir, { recursive: true, force: true })
})

const noopExec: Exec = async () => ({ exitCode: 0, stdout: '', stderr: '' })

const start = (
  driver: PrDriver,
  exec: Exec = noopExec,
  over: Partial<Parameters<typeof startMentionWatcher>[0]> = {},
) => {
  const w = startMentionWatcher({
    repo: 'amagi',
    root: '/repo',
    repoName: 'demo',
    config: config(),
    driver,
    tracker: {} as Tracker,
    intervalMs: 10,
    exec,
    makeHarnessFn: () => fakeHarness(),
    ...over,
  })
  watchers.push(w)
  return w
}

const counter = (w: ReturnType<typeof startMentionWatcher>, label: string): number =>
  w.activity().counters.find((c) => c.label === label)?.value ?? 0

test('scans every open PR each tick and responds to each unhandled mention exactly once', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru what is this?' }]
  driver.prs = [prInfo()]
  const w = start(driver)

  await Bun.sleep(60)

  // Handled-set dedup: the mention is replied to once even though every tick
  // re-lists comments.
  expect(driver.posted).toHaveLength(1)
  expect(driver.listCalls).toBeGreaterThan(1)
  const activity = w.activity()
  expect(activity.ok).toBe(true)
  expect(counter(w, 'scanned')).toBeGreaterThanOrEqual(1)
  expect(counter(w, 'responded')).toBe(1)
  expect(activity.runs).toBeGreaterThanOrEqual(1)
  expect(activity.successes).toBe(activity.runs)
  expect(activity.failures).toBe(0)
  expect(activity.status).toBe('active')
  expect(activity.nextRunAt).toBeGreaterThan(activity.lastRunAt)
})

test('a new mention is noticed even when the PR updatedAt does not change', async () => {
  const driver = new FakePr()
  driver.comments = []
  driver.prs = [prInfo()]
  start(driver)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(0)

  // A human mentions the agent, but the forge never moves the PR's updatedAt.
  // The watcher must still pick the mention up on the next tick.
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru what is this?' }]
  await Bun.sleep(60)

  expect(driver.posted).toHaveLength(1)
})

test('responds to fresh mentions added to an already-scanned PR', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  driver.prs = [prInfo()]
  const w = start(driver)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(1)

  // A new comment mentioning the agent lands; the next tick responds to it.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '2', user: 'alice', body: '@chise-maru and this?' },
  ]
  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(2)
  expect(driver.posted[1]).toContain('@alice')
  expect(counter(w, 'responded')).toBe(2)
})

test('a later mention in a lower-numbered id space (issue comment) is not skipped by a higher review id', async () => {
  const driver = new FakePr()
  // A review id lives in a different, much larger id space than issue comments.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '9000000000', user: 'carol', body: 'review summary, no mention' },
  ]
  driver.prs = [prInfo()]
  start(driver)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(1)

  // New issue comment (smaller id than the review id) mentions the agent.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '9000000000', user: 'carol', body: 'review summary, no mention' },
    { id: '2', user: 'alice', body: '@chise-maru and this?' },
  ]
  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(2)
  expect(driver.posted[1]).toContain('@alice')
})

test('a failed response is retried on later ticks, not marked handled', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  driver.prs = [prInfo()]
  driver.failPost = 10
  const w = start(driver)

  await Bun.sleep(60)
  // Every attempt fails: nothing posted, nothing recorded as handled.
  expect(driver.posted).toHaveLength(0)
  expect(w.activity().ok).toBe(true)
  expect(counter(w, 'responded')).toBe(0)
  expect(counter(w, 'scanned')).toBeGreaterThanOrEqual(1)

  driver.failPost = 0
  await Bun.sleep(40)
  expect(driver.posted).toHaveLength(1)
  expect(counter(w, 'responded')).toBe(1)
})

test('a tick that throws is counted as a failure and keeps run totals consistent', async () => {
  const driver = new FakePr()
  driver.listOpenPrs = async () => {
    throw new Error('boom')
  }
  const w = start(driver)

  await Bun.sleep(30)
  const a = w.activity()
  expect(a.ok).toBe(false)
  expect(a.failures).toBeGreaterThanOrEqual(1)
  expect(a.runs).toBeGreaterThanOrEqual(a.failures)
  expect(a.successes + a.failures).toBe(a.runs)
})

test('records classification outcomes as mention.classified events when a store is wired', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru what is this?' }]
  driver.prs = [prInfo()]
  const store = new Store(openDatabase(':memory:'))
  start(driver, noopExec, { store })

  await Bun.sleep(60)

  expect(driver.posted).toHaveLength(1)
  const events = store.events()
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    taskId: null,
    type: 'mention.classified',
    prNumber: 7,
    mentionId: '1',
    kind: 'ambiguous',
    reply: 'ambiguous',
  })
  store.close()
})
