import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintCommitMessage } from './commit-lint.ts'
import { Config } from './config.ts'
import { type ConflictLogLevel, resolveConflict, stageResolved } from './conflict.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type { AgentOutcome, AgentStartOptions, Harness } from './drivers/types.ts'
import { type Exec, type ExecResult, exec as realExec } from './exec.ts'
import type { PrInfo } from './pr-check.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): {
  exec: Exec
  calls: Call[]
  inputs: string[]
} {
  const calls: Call[] = []
  const inputs: string[] = []
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd)
    if (cmd[1] === 'commit' && opts?.stdin !== undefined) inputs.push(opts.stdin)
    if (cmd.includes('origin/main^{commit}'))
      return { exitCode: 0, stdout: 'base-oid\n', stderr: '' }
    const hit = routes(cmd)
    if (hit) return hit
    if (cmd.includes('get-url') && cmd.includes('--push')) {
      return { exitCode: 0, stdout: 'git@github.com:owner/repo.git\n', stderr: '' }
    }
    if (cmd.includes('--symref'))
      return { exitCode: 0, stdout: 'ref: refs/heads/main\tHEAD\n', stderr: '' }
    if (cmd[1] === 'diff') return { exitCode: 1, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls, inputs }
}

function fakeDriver(
  mergeStatus: 'mergeable' | 'conflicted' | 'unknown' = 'mergeable',
): PrDriver & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
      throw new Error('unused')
    },
    async getPr(_cwd: string, _number: number): Promise<PrState> {
      return 'open'
    },
    async getPrLabels(_cwd: string, _number: number): Promise<string[]> {
      return []
    },
    async listOpenPrs(_cwd: string): Promise<PrInfo[]> {
      return []
    },
    async getMergeStatus(_cwd: string, number: number) {
      calls.push(number)
      return mergeStatus
    },
    async getPrDiff(_cwd: string, _number: number): Promise<string> {
      return ''
    },
    async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
      return []
    },
    async postComment(_cwd: string, _number: number, _body: string): Promise<void> {},
    async closePr(_cwd: string, _number: number, _reason: string): Promise<void> {},
    async addLabel(_cwd: string, _number: number, _label: string): Promise<void> {},
    async removeLabel(_cwd: string, _number: number, _label: string): Promise<void> {},
    async deleteBranch(): Promise<void> {},
  }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  body: '',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefOid: 'deadbeef',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: [],
  ...over,
})

/** A merge into the PR worktree that conflicts until the agent resolves the file. */
let unmergedReported = false
const conflicted = (c: Call): ExecResult | undefined => {
  if (c.includes('MERGE_HEAD')) return ok('merge-head')
  if (c.includes('rev-parse')) return fail('')
  if (c.includes('merge')) return fail('conflict')
  if (c.includes('--diff-filter=U')) {
    if (unmergedReported) return ok('')
    unmergedReported = true
    return ok('src/a.txt\n')
  }
  return undefined
}

const emptyEvents = async function* (): AsyncGenerator<never> {}

function fakeHarness(
  over: Partial<AgentOutcome> = {},
  onStart?: (opts: AgentStartOptions) => void,
): Harness {
  const outcome: AgentOutcome = {
    exitCode: 0,
    ok: true,
    sessionId: null,
    summary: 'done',
    usage: null,
    stderr: '',
    ...over,
  }
  const process = {
    pid: -1,
    events: () => emptyEvents(),
    done: Promise.resolve(outcome),
    kill: async () => {},
    model: null,
    effort: null,
  }
  return {
    kind: 'fake',
    start: (opts: AgentStartOptions) => {
      onStart?.(opts)
      return process
    },
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

const config = () =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    checks: { commands: [], format: null, lint: null },
  })

beforeEach(() => {
  unmergedReported = false
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

describe('resolveConflict', () => {
  test('pushes the merge when the base merges cleanly, without starting an agent', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return ok('Already up to date')
      return undefined
    })
    const logs: string[] = []
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
      makeHarnessFn: () => fakeHarness(),
      onLog: (_level, text) => logs.push(text),
    })

    expect(result.ok).toBe(true)
    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
    const merge = calls.find((call) => call[1] === 'merge')
    expect(lintCommitMessage(merge?.[3] ?? '')).toEqual([])
    expect(logs).toContain('base merges cleanly; pushed the merge to update the PR')
  })

  test('dispatches the agent, pushes the fix, and reports the merge status', async () => {
    const started: string[] = []
    const cfg = config()
    cfg.harness.implement.model = 'base-model'
    cfg.watchers.prConflict.kind = 'opencode'
    cfg.watchers.prConflict.model = 'conflict-model'
    cfg.watchers.prConflict.effort = 'high'
    cfg.watchers.prConflict.seat = 'conflict-seat'
    let startedWith: Config['harness']['implement'] | undefined
    const { exec, calls } = fake((c) => {
      if (c.includes('MERGE_HEAD')) return ok('merge-head')
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      if (c.includes('--diff-filter=U')) {
        if (unmergedReported) return ok('')
        unmergedReported = true
        return ok('src/a.txt\n')
      }
      if (c.includes('reflog')) {
        return ok('aaa checkout: initial\n')
      }
      return undefined
    })
    const logs: { level: ConflictLogLevel; text: string }[] = []
    const bypassed: string[][] = []
    const driver = fakeDriver()
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: cfg,
      driver,
      exec,
      makeHarnessFn: (cfg) => {
        started.push(cfg.kind)
        startedWith = cfg
        return fakeHarness()
      },
      onLog: (level, text) => logs.push({ level, text }),
      onGitBypassed: (entries) => bypassed.push(entries),
    })

    expect(result.ok).toBe(true)
    expect(started).toEqual(['opencode'])
    expect(startedWith).toMatchObject({
      kind: 'opencode',
      model: 'conflict-model',
      effort: 'high',
      seat: 'conflict-seat',
    })
    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
    expect(driver.calls).toContain(7)
    expect(logs.some((l) => l.level === 'ok' && l.text.includes('mergeable'))).toBe(true)
    expect(bypassed).toEqual([])
  })

  test('blocks an empty merge diff regardless of the agent verdict', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('MERGE_HEAD')) return ok('merge-head')
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      if (c.includes('--diff-filter=U')) {
        if (unmergedReported) return ok('')
        unmergedReported = true
        return ok('src/a.txt\n')
      }
      if (c[1] === 'diff') return ok('')
      return undefined
    })
    let verdictPath = ''
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
      makeHarnessFn: () =>
        fakeHarness({}, (opts) => {
          const found = opts.prompt.match(/Verdict file: (.+)/)
          verdictPath = found?.[1] ?? ''
          writeFileSync(
            verdictPath,
            'CLOSE TASK\nREASONING:\nBase already has it.\nPROPOSAL:\nClose am-1.',
          )
        }),
    })

    expect(result.ok).toBe(false)
    expect(result.contained).toBe(true)
    expect(result.message).toContain('skipped the empty merge push')
    expect(result.verdict?.verdict).toBe('CLOSE TASK')
    expect(calls.some((c) => c.includes('push'))).toBe(false)
    // Against the commit that was merged: origin/main may have moved during the agent run.
    expect(calls).toContainEqual(['git', 'diff', '--quiet', 'base-oid', 'HEAD'])
  })

  test('pushes a real merge even when the agent verdict is not resolved', async () => {
    const { exec, calls } = fake(conflicted)
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
      makeHarnessFn: () =>
        fakeHarness({}, (opts) => {
          const found = opts.prompt.match(/Verdict file: (.+)/)
          writeFileSync(
            found?.[1] ?? '',
            'NEW TASK\nREASONING:\nBase changed it.\nPROPOSAL:\nTrack remainder.',
          )
        }),
    })

    expect(result.ok).toBe(true)
    expect(result.verdict?.verdict).toBe('NEW TASK')
    expect(result.message).toContain('agent verdict: NEW TASK')
    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
  })

  test('re-dispatches unresolved paths until the agent resolves them, then the runner commits', async () => {
    let diffPass = 0
    let launches = 0
    const started: AgentStartOptions[] = []
    const { exec, calls, inputs } = fake((c) => {
      if (c.includes('MERGE_HEAD')) return ok('merge-head')
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      if (c.includes('--diff-filter=U')) {
        diffPass++
        return ok(diffPass <= 2 ? 'src/a.txt\n' : '')
      }
      if (c.includes('reflog')) return ok('same head\n')
      return undefined
    })
    const store = new Store(openDatabase(':memory:'))
    store.append('am-1', { type: 'task.claimed', title: 'Do the thing', tracker: 'beads' })
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      store,
      exec,
      makeHarnessFn: () => {
        launches++
        return fakeHarness({}, (opts) => started.push(opts))
      },
    })

    expect(result.ok).toBe(true)
    expect(launches).toBe(2)
    expect(result.iteration).toBe(2)
    expect(calls).toContainEqual(['git', 'add', '-A'])
    expect(calls).toContainEqual(['git', 'commit', '-F', '-'])
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain('[am-1] Do the thing')
    expect(inputs[0]).toContain('Merge: main -> amagi/am-1-do-the-thing. Conflict #2')
    expect(inputs[0]?.trim().split('\n').at(-1)).toMatch(/^Generated by amagi/)
    expect(lintCommitMessage(inputs[0] ?? '')).toEqual([])
    expect(started.every((opts) => opts.env?.AMAGI_WORKTREE === '/wt/amagi-pr-7')).toBe(true)
    expect(started.every((opts) => opts.env?.AMAGI_REPO_ROOT === '/repo')).toBe(true)
  })

  test('a manual request keeps dispatching past the automatic limit until resolved', async () => {
    let diffPass = 0
    let launches = 0
    const { exec } = fake((c) => {
      if (c.includes('MERGE_HEAD')) return ok('merge-head')
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      if (c.includes('--diff-filter=U')) {
        diffPass++
        return ok(diffPass <= 2 ? 'src/a.txt\n' : '')
      }
      return undefined
    })
    const cfg = config()
    cfg.loop.conflictMaxIterations = 1
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr({ labels: ['amagi/iterations:3'] }),
      config: cfg,
      driver: fakeDriver(),
      exec,
      manual: true,
      makeHarnessFn: () => {
        launches++
        return fakeHarness()
      },
    })

    expect(result.ok).toBe(true)
    expect(launches).toBe(2)
    expect(result.iteration).toBe(5)
  })

  test('reports a failed agent without pushing', async () => {
    const { exec, calls } = fake(conflicted)
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
      makeHarnessFn: () => fakeHarness({ ok: false, stderr: 'model overloaded' }),
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('model overloaded')
    expect(calls.some((c) => c.includes('push'))).toBe(false)
  })

  test('out of iterations, parks a pr_open task and leaves a task already off pr_open alone', async () => {
    const store = new Store(openDatabase(':memory:'))
    store.append('am-1', { type: 'task.claimed', title: 'x', tracker: 'beads' })
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
    ] as const) {
      store.append('am-1', { type: 'task.state', from: null, to })
    }
    const capped = pr({ labels: ['amagi/iterations:3'] })
    const run = () =>
      resolveConflict({
        repoRoot: '/repo',
        repoName: 'amagi',
        pr: capped,
        config: config(),
        driver: fakeDriver(),
        store,
        exec: fake(conflicted).exec,
        makeHarnessFn: () => fakeHarness(),
      })

    const first = await run()
    expect(first.ok).toBe(false)
    expect(first.message).toContain('task marked pr_merge_conflict')
    expect(store.task('am-1')?.state).toBe('pr_merge_conflict')

    unmergedReported = false
    const again = await run()
    expect(again.ok).toBe(false)
    expect(again.message).toContain('unmerged paths remain after 3 dispatches')
    expect(again.message).not.toContain('parked')
    expect(again.message).not.toContain('illegal transition')
  })

  test('catches git failures and returns ok: false', async () => {
    const { exec } = fake((c) => {
      if (c.includes('fetch')) return fail('remote gone')
      return undefined
    })
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('remote gone')
  })
})

describe('stageResolved', () => {
  let dir: string
  const git = async (...args: string[]) =>
    realExec(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir })
  const unmerged = async () =>
    (await git('diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean)

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'amagi-stage-'))
    await git('init', '-q', '-b', 'main')
    for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, f), 'base\n')
    await git('add', '-A')
    await git('commit', '-q', '--no-verify', '-m', 'base')
    await git('checkout', '-q', '-b', 'pr')
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(dir, f), 'pr\n')
    await git('commit', '-q', '--no-verify', '-am', 'pr')
    await git('checkout', '-q', 'main')
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(dir, f), 'main\n')
    await git('commit', '-q', '--no-verify', '-am', 'main')
    await git('checkout', '-q', 'pr')
    expect((await git('merge', 'main')).exitCode).not.toBe(0)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('stages resolved paths and keeps a path with conflict markers unmerged', async () => {
    writeFileSync(join(dir, 'a.txt'), 'merged\n')
    await stageResolved(realExec, dir, await unmerged())
    expect(await unmerged()).toEqual(['b.txt'])
  })

  test('once every conflict is resolved, stages the whole tree so the merge commits', async () => {
    writeFileSync(join(dir, 'a.txt'), 'merged\n')
    writeFileSync(join(dir, 'b.txt'), 'merged\n')
    writeFileSync(join(dir, 'c.txt'), 'touched outside the conflict\n')
    await stageResolved(realExec, dir, await unmerged())
    expect(await unmerged()).toEqual([])
    expect((await git('commit', '-q', '--no-verify', '--no-edit')).exitCode).toBe(0)
    expect((await git('status', '--porcelain')).stdout).toBe('')
  })
})
