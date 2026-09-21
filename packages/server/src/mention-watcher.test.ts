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
  updatedAt: '2026-09-21T10:00:00Z',
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
    return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
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

const stateFile = (): Record<string, { updatedAt: string; lastCommentId: number }> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'mentions', 'demo.watch.json'), 'utf8') as string)

test('scans open PRs once and responds to each unhandled mention exactly once', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru what is this?' }]
  driver.prs = [prInfo()]
  const w = start(driver)

  await Bun.sleep(60)

  expect(driver.posted).toHaveLength(1)
  expect(driver.listCalls).toBe(1)
  const activity = w.activity()
  expect(activity.ok).toBe(true)
  expect(activity.prsScanned).toBe(1)
  expect(activity.mentionsResponded).toBe(1)
  expect(stateFile()['7']).toEqual({ updatedAt: '2026-09-21T10:00:00Z', lastCommentId: 1 })
})

test('skips re-scanning PRs whose updatedAt has not changed', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  driver.prs = [prInfo()]
  start(driver)

  await Bun.sleep(60)
  const postsAfterFirst = driver.posted.length

  await Bun.sleep(40)
  expect(driver.listCalls).toBe(1)
  expect(driver.posted.length).toBe(postsAfterFirst)
})

test('only responds to mentions added after the last-seen comment when a PR changes', async () => {
  const driver = new FakePr()
  driver.comments = [{ id: '1', user: 'bob', body: '@chise-maru hi' }]
  driver.prs = [prInfo()]
  start(driver)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(1)

  // New activity on the PR: a fresh comment mentioning the agent.
  driver.comments = [
    { id: '1', user: 'bob', body: '@chise-maru hi' },
    { id: '2', user: 'alice', body: '@chise-maru and this?' },
  ]
  const w1 = watchers[0]
  w1?.stop()
  driver.prs = [prInfo({ updatedAt: '2026-09-21T11:00:00Z' })]
  const w2 = start(driver)

  await Bun.sleep(60)
  expect(driver.posted).toHaveLength(2)
  const second = driver.posted[1]
  expect(second).toContain('@alice')
  expect(w2.activity().mentionsResponded).toBe(1)
  expect(stateFile()['7']).toEqual({ updatedAt: '2026-09-21T11:00:00Z', lastCommentId: 2 })
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
  expect(w.activity().mentionsResponded).toBe(0)
  expect(w.activity().prsScanned).toBeGreaterThanOrEqual(1)
  // State never advances, so the same PR is re-scanned each tick.
  expect(readFileSync(join(cacheDir, 'amagi', 'mentions', 'demo.watch.json'), 'utf8')).toBe('{}')

  driver.failPost = 0
  await Bun.sleep(40)
  expect(driver.posted).toHaveLength(1)
  expect(w.activity().mentionsResponded).toBe(1)
  expect(stateFile()['7']).toBeDefined()
})
