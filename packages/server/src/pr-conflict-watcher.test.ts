import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  type CreatePrOptions,
  type Exec,
  type Harness,
  type OpenPr,
  openDatabase,
  type PrComment,
  type PrDriver,
  type PrInfo,
  type PrState,
  type PullRequest,
  Store,
  type Tracker,
} from '@amagi/core'
import { startPrConflictWatcher } from './pr-conflict-watcher.ts'

const config = (): Config =>
  Config.parse({ repo: { baseBranch: 'main', worktreeRoot: '/wt' }, checks: { commands: [] } })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefOid: 'deadbeef',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: [],
  ...over,
})

function fakeExec(prs: () => PrInfo[]): Exec {
  return async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return { exitCode: 0, stdout: JSON.stringify(prs()), stderr: '' }
    }
    if (cmd.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd.includes('merge')) return { exitCode: 1, stdout: '', stderr: 'conflict' }
    if (cmd.includes('view')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

class FakePr implements PrDriver {
  readonly addedLabels: string[] = []
  readonly removedLabels: string[] = []
  readonly postedComments: string[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    throw new Error('unused')
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async listOpenPrs(_cwd: string): Promise<OpenPr[]> {
    return []
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, body: string): Promise<void> {
    this.postedComments.push(body)
  }
  async addLabel(_cwd: string, _number: number, label: string): Promise<void> {
    this.addedLabels.push(label)
  }
  async removeLabel(_cwd: string, _number: number, label: string): Promise<void> {
    this.removedLabels.push(label)
  }
}

const fakeTracker = (): Tracker & { comments: { id: string; body: string }[] } => {
  const comments: { id: string; body: string }[] = []
  return {
    kind: 'fake',
    leaseTtlMs: 300_000,
    capabilities: { create: false, edit: false, dependencies: false },
    comments,
    async ready(): Promise<never[]> {
      return []
    },
    async claim(): Promise<null> {
      return null
    },
    async get(): Promise<null> {
      return null
    },
    async createTask(): Promise<never> {
      throw new Error('unsupported')
    },
    async updateTask(): Promise<never> {
      throw new Error('unsupported')
    },
    async heartbeat(): Promise<boolean> {
      return true
    },
    async comment(id: string, body: string): Promise<void> {
      comments.push({ id, body })
    },
    async setStatus(): Promise<void> {},
    async release(): Promise<void> {},
    async close(): Promise<void> {},
    async openGate(): Promise<{ id: string; advisory: boolean }> {
      return { id: 'gate', advisory: true }
    },
    async gateResolved(): Promise<boolean> {
      return true
    },
    async resolveGate(): Promise<void> {},
  }
}

function fakeHarness(onStart: () => void): Harness {
  const process = {
    pid: -1,
    events: async function* () {},
    done: Promise.resolve({
      exitCode: 0,
      ok: true,
      sessionId: null,
      summary: 'done',
      usage: null,
      stderr: '',
    }),
    kill: async () => {},
    model: null,
    effort: null,
  }
  return {
    kind: 'fake',
    start: (_opts: { cwd: string; prompt: string; systemPrompt: string }) => {
      onStart()
      return process
    },
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

let cacheDir: string
const watchers: ReturnType<typeof startPrConflictWatcher>[] = []

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  cacheDir = mkdtempSync(join(tmpdir(), 'amagi-conflict-watch-'))
  process.env.XDG_CACHE_HOME = cacheDir
})

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop()
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.XDG_CACHE_HOME
  rmSync(cacheDir, { recursive: true, force: true })
})

const start = (
  exec: Exec,
  makeHarnessFn: () => Harness,
  over: Partial<Parameters<typeof startPrConflictWatcher>[0]> = {},
) => {
  const w = startPrConflictWatcher({
    repo: 'amagi',
    root: '/repo',
    repoName: 'demo',
    config: config(),
    store: new Store(openDatabase(':memory:')),
    tracker: fakeTracker(),
    driver: new FakePr(),
    intervalMs: 10,
    exec,
    makeHarnessFn,
    ...over,
  })
  watchers.push(w)
  return w
}

const stateFile = (): Record<string, { headOid: string }> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'conflicts', 'demo.json'), 'utf8') as string)

const counter = (w: ReturnType<typeof startPrConflictWatcher>, label: string): number =>
  w.activity().counters.find((c) => c.label === label)?.value ?? 0

test('lists open PRs, resolves only conflicting ones, and records counters', async () => {
  let started = 0
  const exec = fakeExec(() => [
    pr(),
    pr({ number: 8, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
  ])
  const w = start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)

  const activity = w.activity()
  expect(activity.ok).toBe(true)
  expect(counter(w, 'scanned')).toBe(2)
  expect(counter(w, 'conflicting')).toBe(1)
  expect(counter(w, 'resolved')).toBe(1)
  expect(started).toBe(1)
  expect(stateFile()['7']).toEqual({ headOid: 'deadbeef' })
  expect(activity.runs).toBeGreaterThanOrEqual(1)
  expect(activity.successes).toBe(activity.runs)
  expect(activity.failures).toBe(0)
  expect(activity.status).toBe('active')
  expect(activity.nextRunAt).toBeGreaterThan(activity.lastRunAt)
})

test('does not re-attempt a conflicting PR until its head SHA changes', async () => {
  let started = 0
  const exec = fakeExec(() => [pr()])
  const w = start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)
  const afterFirst = started

  await Bun.sleep(60)
  expect(started).toBe(afterFirst)
  expect(counter(w, 'resolved')).toBeGreaterThanOrEqual(1)
})

test('re-attempts a conflicting PR once its head SHA changes', async () => {
  let started = 0
  let head = 'deadbeef'
  const exec = fakeExec(() => [pr({ headRefOid: head })])
  start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)

  head = 'newsha'
  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(2)
  expect(stateFile()['7']).toEqual({ headOid: 'newsha' })
})

test('a failed resolution is recorded so the same head is not retried', async () => {
  let started = 0
  const fail = true
  const exec = fakeExec(() => [pr()])
  const w = start(exec, () =>
    fakeHarness(() => {
      started++
      if (fail) throw new Error('agent failed: model overloaded')
    }),
  )

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)
  expect(counter(w, 'resolved')).toBe(0)

  const afterFirst = started
  await Bun.sleep(60)
  expect(started).toBe(afterFirst)
  expect(stateFile()['7']).toEqual({ headOid: 'deadbeef' })
})

test('a conflicting PR that stops conflicting drops out of the state file', async () => {
  let conflicting = true
  const exec = fakeExec(() => [
    pr({
      mergeable: conflicting ? 'CONFLICTING' : 'MERGEABLE',
      mergeStateStatus: conflicting ? 'DIRTY' : 'CLEAN',
    }),
  ])
  start(exec, () => fakeHarness(() => {}))

  await Bun.sleep(60)
  expect(stateFile()['7']).toBeDefined()

  conflicting = false
  await Bun.sleep(60)
  expect(stateFile()['7']).toBeUndefined()
})

test('fetches every open PR head each tick when a head moved', async () => {
  let started = 0
  const calls: string[][] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd as string[])
    if (cmd.includes('ls-remote')) {
      return { exitCode: 0, stdout: `abc123\trefs/pull/7/head\n`, stderr: '' }
    }
    if (cmd.includes('gh') && cmd.includes('list')) {
      return { exitCode: 0, stdout: JSON.stringify([pr()]), stderr: '' }
    }
    if (cmd.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd.includes('merge')) return { exitCode: 1, stdout: '', stderr: 'conflict' }
    if (cmd.includes('view')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)
  const fetches = calls.filter((c) => c[0] === 'git' && c[1] === 'fetch')
  expect(fetches).toContainEqual([
    'git',
    'fetch',
    '--prune',
    'origin',
    '+refs/pull/*/head:refs/remotes/origin/pr/*',
  ])
  expect(started).toBeGreaterThanOrEqual(1)
})

test('a tick that fails to list PRs reports the error and keeps the previous stamp', async () => {
  const failing: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: not logged in' })
  const w = start(failing, () => fakeHarness(() => {}))

  await Bun.sleep(60)

  const activity = w.activity()
  expect(activity.ok).toBe(false)
  expect(activity.error).toContain('not logged in')
  expect(activity.lastRunAt).toBeGreaterThan(0)
})

const mergeTreeConfig = (): Config =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    checks: { commands: [] },
    loop: { mergeTreeCheck: true },
  })

const mergeTreeLog = (): { pr: number; local: string; github: string; headOid: string }[] =>
  readFileSync(join(cacheDir, 'amagi', 'merge-tree', 'demo.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { pr: number; local: string; github: string; headOid: string })

test('records merge-tree observations and divergences when the flag is on', async () => {
  const local = new Map<number, 'conflict' | 'clean'>()
  const exec: Exec = async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          pr({ number: 7, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
          pr({ number: 8, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        ]),
        stderr: '',
      }
    }
    if (cmd.includes('merge-tree')) {
      const head = cmd[cmd.length - 1] ?? ''
      const n = Number(head.match(/pr\/(\d+)\/head/)?.[1] ?? '0')
      return local.get(n) === 'conflict'
        ? { exitCode: 1, stdout: '', stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd.includes('merge')) return { exitCode: 1, stdout: '', stderr: 'conflict' }
    if (cmd.includes('view')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  local.set(7, 'clean')
  local.set(8, 'conflict')
  const w = start(exec, () => fakeHarness(() => {}), { config: mergeTreeConfig() })

  await Bun.sleep(60)

  // #8 conflicts locally while GitHub reports it mergeable: the divergence.
  expect(counter(w, 'divergent')).toBeGreaterThanOrEqual(1)
  const rows = mergeTreeLog()
  expect(rows.length).toBeGreaterThanOrEqual(2)
  expect(rows.some((r) => r.pr === 7 && r.local === 'clean' && r.github === 'clean')).toBe(true)
  expect(rows.some((r) => r.pr === 8 && r.local === 'conflict' && r.github === 'clean')).toBe(true)
})

test('UNKNOWN mergeable is forced per-PR and never counts as a divergence', async () => {
  let views = 0
  const exec: Exec = async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          pr({ number: 7, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
        ]),
        stderr: '',
      }
    }
    if (cmd.includes('merge-tree')) return { exitCode: 0, stdout: '', stderr: '' }
    if (cmd.includes('view')) {
      views++
      return {
        exitCode: 0,
        stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }
    }
    if (cmd.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd.includes('merge')) return { exitCode: 1, stdout: '', stderr: 'conflict' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const w = start(exec, () => fakeHarness(() => {}), { config: mergeTreeConfig() })

  await Bun.sleep(60)

  expect(views).toBeGreaterThanOrEqual(1)
  expect(counter(w, 'divergent')).toBe(0)
  const rows = mergeTreeLog()
  expect(rows.length).toBeGreaterThanOrEqual(1)
  expect(rows.some((r) => r.pr === 7 && r.local === 'clean' && r.github === 'clean')).toBe(true)
})

test('merge-tree observations stay off when the flag is off', async () => {
  const exec = fakeExec(() => [pr()])
  start(exec, () => fakeHarness(() => {}))

  await Bun.sleep(60)

  expect(existsSync(join(cacheDir, 'amagi', 'merge-tree', 'demo.jsonl'))).toBe(false)
})

const openPrTask = (store: Store): void => {
  store.append('bd-1', { type: 'task.claimed', title: 'pr work', tracker: 'beads' })
  store.append('bd-1', {
    type: 'pr.created',
    url: 'https://github.com/owner/repo/pull/7',
    number: 7,
  })
  for (const to of ['worktree_ready', 'implementing', 'checks', 'committed', 'pr_open'] as const) {
    store.append('bd-1', { type: 'task.state', from: null, to })
  }
}

function fakeExecForPointless(diff: () => string, head: () => string = () => 'deadbeef'): Exec {
  return async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            ...pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefOid: head() }),
            labels: [{ name: 'amagi' }],
          },
        ]),
        stderr: '',
      }
    }
    if (cmd.includes('diff')) return { exitCode: 0, stdout: diff(), stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

const pointlessStateFile = (): Record<string, { headOid: string; flagged: boolean }> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'pointless', 'demo.json'), 'utf8') as string)

test('an amagi PR with an empty diff gets labelled, commented on and parked in pr_flagged', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPrTask(store)
  const tracker = fakeTracker()
  const driver = new FakePr()
  start(
    fakeExecForPointless(() => ''),
    () => fakeHarness(() => {}),
    { store, tracker, driver },
  )

  await Bun.sleep(60)

  expect(store.task('bd-1')?.state).toBe('pr_flagged')
  expect(driver.addedLabels).toEqual(['amagi/needs-closing'])
  expect(driver.postedComments).toHaveLength(1)
  expect(tracker.comments).toHaveLength(1)
  expect(tracker.comments[0]?.body).toBe(driver.postedComments[0])
  expect(pointlessStateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: true })
})

test('a PR without the amagi label is never flagged whatever its diff', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPrTask(store)
  const tracker = fakeTracker()
  const driver = new FakePr()
  const exec: Exec = async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            ...pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
            labels: [],
          },
        ]),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  start(exec, () => fakeHarness(() => {}), { store, tracker, driver })

  await Bun.sleep(60)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(driver.addedLabels).toEqual([])
  expect(driver.postedComments).toEqual([])
  expect(tracker.comments).toEqual([])
})

test('a flagged PR that receives real commits is cleared back to pr_open without a second comment', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPrTask(store)
  const tracker = fakeTracker()
  const driver = new FakePr()
  let diff = ''
  let head = 'deadbeef'
  start(
    fakeExecForPointless(
      () => diff,
      () => head,
    ),
    () => fakeHarness(() => {}),
    {
      store,
      tracker,
      driver,
    },
  )

  await Bun.sleep(60)
  expect(store.task('bd-1')?.state).toBe('pr_flagged')

  diff = 'a real diff\n'
  head = 'newsha'
  await Bun.sleep(60)

  expect(store.task('bd-1')?.state).toBe('pr_open')
  expect(driver.removedLabels).toEqual(['amagi/needs-closing'])
  // one comment from the flagging, none from the clearing
  expect(driver.postedComments).toHaveLength(1)
  expect(tracker.comments).toHaveLength(1)
  expect(pointlessStateFile()['7']).toEqual({ headOid: 'newsha', flagged: false })
})

test('an unchanged flagged PR is not re-commented on subsequent ticks', async () => {
  const store = new Store(openDatabase(':memory:'))
  openPrTask(store)
  const tracker = fakeTracker()
  const driver = new FakePr()
  start(
    fakeExecForPointless(() => ''),
    () => fakeHarness(() => {}),
    { store, tracker, driver },
  )

  await Bun.sleep(60)
  expect(store.task('bd-1')?.state).toBe('pr_flagged')
  const commentsAfterFirst = driver.postedComments.length

  await Bun.sleep(60)
  expect(driver.postedComments.length).toBe(commentsAfterFirst)
  expect(driver.addedLabels).toEqual(['amagi/needs-closing'])
})
