import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type { GateRef, Harness, Tracker } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { flagPointlessPrs, parsePointlessVerdict, prDiffEmpty } from './pointless.ts'
import type { PrInfo } from './pr-check.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

type Call = readonly string[]

const config = (): Config =>
  Config.parse({ repo: { baseBranch: 'main', worktreeRoot: '/wt' }, checks: { commands: [] } })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  body: '',
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
  async listOpenPrs(_cwd: string): Promise<PrInfo[]> {
    return []
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async getPrDiff(_cwd: string, _number: number): Promise<string> {
    return ''
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, body: string): Promise<void> {
    this.postedComments.push(body)
  }
  async closePr(_cwd: string, _number: number, _reason: string): Promise<void> {}
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

let pendingVerdict: string | null = null

const fakeHarness = (): Harness => {
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
    start: ({ prompt }) => {
      const outPath = prompt.match(/^file: (.+)$/m)?.[1]
      if (outPath !== undefined && pendingVerdict !== null) {
        writeFileSync(outPath, pendingVerdict)
        pendingVerdict = null
      }
      return process
    },
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

/** The verdict staged for the fake harness on its next start. */
const writeVerdict = (raw: string): void => {
  pendingVerdict = raw
}

type FlagOpts = {
  store: Store
  tracker: ReturnType<typeof fakeTracker>
  driver: FakePr
  config: Config
  makeHarnessFn: () => Harness
  cwd: string
  repoName: string
  prs: PrInfo[]
  exec: Exec
}

const opts = (over: Partial<FlagOpts> = {}): FlagOpts => {
  const store = new Store(openDatabase(':memory:'))
  openPrTask(store)
  const driver = new FakePr()
  const tracker = fakeTracker()
  const { exec } = pass()
  return {
    store,
    tracker,
    driver,
    config: config(),
    makeHarnessFn: fakeHarness,
    cwd: '/repo',
    repoName: 'demo',
    prs: [pr()],
    exec,
    ...over,
  }
}

let cacheDir: string

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'amagi-pointless-'))
  process.env.XDG_CACHE_HOME = cacheDir
})

afterEach(() => {
  pendingVerdict = null
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

describe('parsePointlessVerdict', () => {
  test('picks the verdict line and splits the reasoning from the proposal', () => {
    const v = parsePointlessVerdict(
      [
        'CLOSE TASK',
        '',
        'REASONING:',
        'The feature already landed on main in #42.',
        '',
        'PROPOSAL:',
        'Close bd-1: base already contains this work.',
        '',
      ].join('\n'),
    )
    expect(v.verdict).toBe('CLOSE TASK')
    expect(v.reasoning).toBe('The feature already landed on main in #42.')
    expect(v.proposal).toBe('Close bd-1: base already contains this work.')
  })

  test('accepts every verdict and treats an unknown first line as no verdict', () => {
    for (const verdict of ['RESOLVED', 'CLOSE TASK', 'NEW TASK', 'REPHRASE TASK'] as const) {
      expect(parsePointlessVerdict(`${verdict}\n`).verdict).toBe(verdict)
    }
    const unknown = parsePointlessVerdict('MAYBE\nREASONING:\nx\n')
    expect(unknown.verdict).toBeNull()
    expect(unknown.reasoning).toBe('x')
  })

  test('missing sections come back empty', () => {
    const v = parsePointlessVerdict('NEW TASK\n')
    expect(v.verdict).toBe('NEW TASK')
    expect(v.reasoning).toBe('')
    expect(v.proposal).toBe('')
  })
})

describe('flagPointlessPrs', () => {
  test('no verdict file: falls back to the static reason on the PR and the tracker', async () => {
    const over = opts()
    const result = await flagPointlessPrs(over)

    expect(result).toEqual({ flagged: 1, cleared: 0 })
    expect(over.store.task('bd-1')?.state).toBe('pr_flagged')
    expect(over.driver.addedLabels).toEqual(['amagi/needs-closing'])
    expect(over.driver.postedComments).toHaveLength(1)
    expect(over.tracker.comments).toHaveLength(1)
    expect(over.tracker.comments[0]?.body).toBe(over.driver.postedComments[0])
    expect(stateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: true })
  })

  test('an agent verdict splits the PR comment (reasoning) from the tracker comment (proposal)', async () => {
    writeVerdict(
      [
        'NEW TASK',
        '',
        'REASONING:',
        'Base rewrote this module, so the PR has nothing left to merge.',
        '',
        'PROPOSAL:',
        'File a new task to port the remaining pieces.',
        '',
      ].join('\n'),
    )
    const over = opts()
    const result = await flagPointlessPrs(over)

    expect(result).toEqual({ flagged: 1, cleared: 0 })
    expect(over.driver.postedComments).toEqual([
      'Base rewrote this module, so the PR has nothing left to merge.',
    ])
    expect(over.tracker.comments).toEqual([
      { id: 'bd-1', body: 'File a new task to port the remaining pieces.' },
    ])
    expect(stateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: true })
  })

  test('never touches a PR without the amagi label, whatever its diff', async () => {
    const over = opts({ prs: [pr({ labels: [] })] })
    const result = await flagPointlessPrs(over)

    expect(result).toEqual({ flagged: 0, cleared: 0 })
    expect(over.store.task('bd-1')?.state).toBe('pr_open')
    expect(over.driver.addedLabels).toEqual([])
    expect(over.driver.postedComments).toEqual([])
    expect(over.tracker.comments).toEqual([])
  })

  test('clears a flagged PR once real commits arrive: label removed, back to pr_open, no comment', async () => {
    const over = opts()
    over.store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
    over.exec = pass(() => 'a real diff\n').exec

    const result = await flagPointlessPrs(over)

    expect(result).toEqual({ flagged: 0, cleared: 1 })
    expect(over.store.task('bd-1')?.state).toBe('pr_open')
    expect(over.driver.removedLabels).toEqual(['amagi/needs-closing'])
    expect(over.driver.postedComments).toEqual([])
    expect(over.tracker.comments).toEqual([])
    expect(stateFile()['7']).toEqual({ headOid: 'deadbeef', flagged: false })
  })

  test('an unchanged head is skipped, so the same PR is not re-evaluated every tick', async () => {
    const over = opts()
    const { exec, calls } = pass()
    over.exec = exec

    const first = await flagPointlessPrs(over)
    expect(first).toEqual({ flagged: 1, cleared: 0 })
    const diffsAfterFirst = calls.filter((c) => c.includes('diff')).length

    const again = await flagPointlessPrs(opts())
    expect(again).toEqual({ flagged: 0, cleared: 0 })
    expect(over.driver.postedComments).toHaveLength(1)
    expect(calls.filter((c) => c.includes('diff')).length).toBe(diffsAfterFirst)
  })

  test('a head change on an already-flagged PR does not re-comment', async () => {
    const over = opts()
    over.store.append('bd-1', { type: 'task.state', from: 'pr_open', to: 'pr_flagged' })
    over.prs = [pr({ headRefOid: 'newsha' })]

    const result = await flagPointlessPrs(over)

    expect(result).toEqual({ flagged: 0, cleared: 0 })
    expect(over.store.task('bd-1')?.state).toBe('pr_flagged')
    expect(over.driver.postedComments).toEqual([])
    expect(stateFile()['7']).toEqual({ headOid: 'newsha', flagged: true })
  })
})
