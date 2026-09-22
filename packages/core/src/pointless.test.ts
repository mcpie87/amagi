import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CreatePrOptions,
  OpenPr,
  PrComment,
  PrDriver,
  PrState,
  PullRequest,
} from './drivers/pr.ts'
import type { GateRef, Tracker } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { flagPointlessPrs, prDiffEmpty } from './pointless.ts'
import type { PrInfo } from './pr-check.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

type Call = readonly string[]

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: 'deadbeef',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: ['amagi'],
  ...over,
})

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
    async openGate(): Promise<GateRef> {
      return { id: 'gate', advisory: true }
    },
    async gateResolved(): Promise<boolean> {
      return true
    },
    async resolveGate(): Promise<void> {},
  }
}

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

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'amagi-pointless-'))
  process.env.XDG_CACHE_HOME = cacheDir
})

afterEach(() => {
  delete process.env.XDG_CACHE_HOME
  rmSync(cacheDir, { recursive: true, force: true })
})

const stateFile = (): Record<string, { headOid: string; flagged: boolean }> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'pointless', 'demo.json'), 'utf8') as string)

const pass = (diff: () => string = () => '') => {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    if (cmd.includes('diff')) return { exitCode: 0, stdout: diff(), stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { calls, exec }
}

describe('prDiffEmpty', () => {
  test('is true when gh reports no diff and false otherwise', async () => {
    const empty: Exec = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    const full: Exec = async () => ({ exitCode: 0, stdout: 'diff --git a/x b/x\n', stderr: '' })
    expect(await prDiffEmpty('/repo', 7, empty)).toBe(true)
    expect(await prDiffEmpty('/repo', 7, full)).toBe(false)
  })

  test('throws when gh fails so a broken query never flags a PR', async () => {
    const failing: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: not logged in' })
    await expect(prDiffEmpty('/repo', 7, failing)).rejects.toThrow(/not logged in/)
  })
})

describe('flagPointlessPrs', () => {
  test('flags an amagi PR with an empty diff: label, PR comment, tracker comment, pr_flagged', async () => {
    const store = new Store(openDatabase(':memory:'))
    openPrTask(store)
    const driver = new FakePr()
    const tracker = fakeTracker()
    const { exec } = pass()

    const result = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr()],
      exec,
    })

    expect(result).toEqual({ flagged: 1, cleared: 0 })
    expect(store.task('bd-1')?.state).toBe('pr_flagged')
    expect(driver.addedLabels).toEqual(['amagi/needs-closing'])
    expect(driver.postedComments).toHaveLength(1)
    expect(tracker.comments).toHaveLength(1)
    expect(tracker.comments[0]?.body).toBe(driver.postedComments[0])
    expect(stateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: true })
  })

  test('never touches a PR without the amagi label, whatever its diff', async () => {
    const store = new Store(openDatabase(':memory:'))
    openPrTask(store)
    const driver = new FakePr()
    const tracker = fakeTracker()
    const { exec } = pass()

    const result = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr({ labels: [] })],
      exec,
    })

    expect(result).toEqual({ flagged: 0, cleared: 0 })
    expect(store.task('bd-1')?.state).toBe('pr_open')
    expect(driver.addedLabels).toEqual([])
    expect(driver.postedComments).toEqual([])
    expect(tracker.comments).toEqual([])
  })

  test('clears a flagged PR once real commits arrive: label removed, back to pr_open, no comment', async () => {
    const store = new Store(openDatabase(':memory:'))
    openPrTask(store)
    store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
    const driver = new FakePr()
    const tracker = fakeTracker()
    const { exec } = pass(() => 'a real diff\n')

    const result = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr()],
      exec,
    })

    expect(result).toEqual({ flagged: 0, cleared: 1 })
    expect(store.task('bd-1')?.state).toBe('pr_open')
    expect(driver.removedLabels).toEqual(['amagi/needs-closing'])
    expect(driver.postedComments).toEqual([])
    expect(tracker.comments).toEqual([])
    expect(stateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: false })
  })

  test('an unchanged head is skipped, so the same PR is not re-evaluated every tick', async () => {
    const store = new Store(openDatabase(':memory:'))
    openPrTask(store)
    const driver = new FakePr()
    const tracker = fakeTracker()
    const { exec, calls } = pass()

    const first = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr()],
      exec,
    })
    expect(first).toEqual({ flagged: 1, cleared: 0 })
    const diffsAfterFirst = calls.filter((c) => c.includes('diff')).length

    const again = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr()],
      exec,
    })

    expect(again).toEqual({ flagged: 0, cleared: 0 })
    expect(driver.postedComments).toHaveLength(1)
    expect(calls.filter((c) => c.includes('diff')).length).toBe(diffsAfterFirst)
  })

  test('a head change on an already-flagged PR does not re-comment', async () => {
    const store = new Store(openDatabase(':memory:'))
    openPrTask(store)
    store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
    const driver = new FakePr()
    const tracker = fakeTracker()
    const { exec } = pass()

    const result = await flagPointlessPrs({
      store,
      tracker,
      driver,
      cwd: '/repo',
      repoName: 'demo',
      prs: [pr({ headRefOid: 'newsha' })],
      exec,
    })

    expect(result).toEqual({ flagged: 0, cleared: 0 })
    expect(store.task('bd-1')?.state).toBe('pr_flagged')
    expect(driver.postedComments).toEqual([])
    expect(stateFile()['7']).toEqual({ headOid: 'newsha', flagged: true })
  })
})
