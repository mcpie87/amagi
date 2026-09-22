import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  type CreatePrOptions,
  type Exec,
  type Harness,
  type PrComment,
  type PrDriver,
  type PrInfo,
  type PrState,
  type PullRequest,
  type Tracker,
} from '@amagi/core'
import { startMentionWatcher } from './mention-watcher.ts'

const config = (): Config =>
  Config.parse({ repo: { baseBranch: 'main' }, checks: { commands: [] } })

const prInfo = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: 'deadbeef',
  updatedAt: '2026-09-21T10:00:00Z',
  ...over,
})

function fakeExec(prs: PrInfo[]): Exec {
  return async (cmd) =>
    cmd.includes('pr') && cmd.includes('list')
      ? { exitCode: 0, stdout: JSON.stringify(prs), stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' }
}

class FakePr implements PrDriver {
  comments: PrComment[] = []
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
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
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

const start = (
  driver: PrDriver,
  exec: Exec,
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

const stateFile = (): Record<string, string> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'mentions', 'demo.watch.json'), 'utf8') as string)

const counter = (w: ReturnType<typeof startMentionWatcher>, label: string): number =>
  w.activity().counters.find((c) => c.label === label)?.value ?? 0

test('scans open PRs once and responds to each unhandled mention exactly once', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru what is this?' }]
  const w = start(driver, fakeExec([prInfo()]))

  await Bun.sleep(60)

  expect(driver.posted).toHaveLength(1)
  expect(driver.listCalls).toBe(1)
  const activity = w.activity()
  expect(activity.ok).toBe(true)
  expect(counter(w, 'scanned')).toBe(1)
  expect(counter(w, 'responded')).toBe(1)
  expect(stateFile()['7']).toBe('2026-09-21T10:00:00Z')
  expect(activity.runs).toBeGreaterThanOrEqual(1)
  expect(activity.successes).toBe(activity.runs)
  expect(activity.failures).toBe(0)
  expect(activity.status).toBe('active')
  expect(activity.nextRunAt).toBeGreaterThan(activity.lastRunAt)
})

test('skips re-scanning PRs whose updatedAt has not changed', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  start(driver, fakeExec([prInfo()]))

  await Bun.sleep(60)
  const postsAfterFirst = driver.posted.length

  await Bun.sleep(40)
  expect(driver.listCalls).toBe(1)
  expect(driver.posted.length).toBe(postsAfterFirst)
})

test('only responds to mentions added after the last-seen comment when a PR changes', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  const exec = fakeExec([prInfo()])
  start(driver, exec)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(1)

  // New activity on the PR: a fresh comment mentioning the agent.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '2', user: 'alice', body: '@chise-maru and this?' },
  ]
  const w1 = watchers[0]
  w1?.stop()
  const w2 = start(driver, fakeExec([prInfo({ updatedAt: '2026-09-21T11:00:00Z' })]))

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(2)
  const second = driver.posted[1]
  expect(second).toContain('@alice')
  expect(counter(w2, 'responded')).toBe(1)
  expect(stateFile()['7']).toBe('2026-09-21T11:00:00Z')
})

test('a later mention in a lower-numbered id space (issue comment) is not skipped by a higher review id', async () => {
  const driver = new FakePr()
  // A review id lives in a different, much larger id space than issue comments.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '9000000000', user: 'carol', body: 'review summary, no mention' },
  ]
  const exec = fakeExec([prInfo()])
  start(driver, exec)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(1)
  expect(stateFile()['7']).toBeDefined()

  // New issue comment (smaller id than the review id) mentions the agent.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '9000000000', user: 'carol', body: 'review summary, no mention' },
    { id: '2', user: 'alice', body: '@chise-maru and this?' },
  ]
  const w1 = watchers[0]
  w1?.stop()
  const w2 = start(driver, fakeExec([prInfo({ updatedAt: '2026-09-21T11:00:00Z' })]))

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(2)
  const second = driver.posted[1]
  expect(second).toContain('@alice')
  expect(counter(w2, 'responded')).toBe(1)
})

test('a failed response is retried on later ticks, not marked handled', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  driver.failPost = 10
  const w = start(driver, fakeExec([prInfo()]))

  await Bun.sleep(60)
  // Every attempt fails: nothing posted, nothing recorded as handled.
  expect(driver.posted).toHaveLength(0)
  expect(w.activity().ok).toBe(true)
  expect(counter(w, 'responded')).toBe(0)
  expect(counter(w, 'scanned')).toBeGreaterThanOrEqual(1)
  // State never advances, so the same PR is re-scanned each tick.
  expect(readFileSync(join(cacheDir, 'amagi', 'mentions', 'demo.watch.json'), 'utf8')).toBe('{}')

  driver.failPost = 0
  await Bun.sleep(40)
  expect(driver.posted).toHaveLength(1)
  expect(counter(w, 'responded')).toBe(1)
  expect(stateFile()['7']).toBeDefined()
})

test('a tick that throws is counted as a failure and keeps run totals consistent', async () => {
  const exec: Exec = async () => {
    throw new Error('boom')
  }
  const w = start(new FakePr(), exec)

  await Bun.sleep(30)
  const a = w.activity()
  expect(a.ok).toBe(false)
  expect(a.failures).toBeGreaterThanOrEqual(1)
  expect(a.runs).toBeGreaterThanOrEqual(a.failures)
  expect(a.successes + a.failures).toBe(a.runs)
})
