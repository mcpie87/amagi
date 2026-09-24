import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { Config } from './config.ts'
import { type ConflictLogLevel, resolveConflict } from './conflict.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type { AgentOutcome, AgentStartOptions, Harness } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { PrInfo } from './pr-check.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const hit = routes(cmd)
    if (hit) return hit
    if (cmd[1] === 'diff') return { exitCode: 1, stdout: '', stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
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
    let reflogCalls = 0
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
        reflogCalls++
        return ok(
          reflogCalls === 1
            ? 'aaa checkout: initial\n'
            : 'bbb reset: unexpected\naaa checkout: initial\n',
        )
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
    expect(bypassed).toEqual([['bbb reset: unexpected']])
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
    expect(result.message).toContain('skipped the empty merge push')
    expect(result.verdict?.verdict).toBe('CLOSE TASK')
    expect(calls.some((c) => c.includes('push'))).toBe(false)
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
    const { exec, calls } = fake((c) => {
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
    const result = await resolveConflict({
      repoRoot: '/repo',
      repoName: 'amagi',
      pr: pr(),
      config: config(),
      driver: fakeDriver(),
      exec,
      makeHarnessFn: () => {
        launches++
        return fakeHarness()
      },
    })

    expect(result.ok).toBe(true)
    expect(launches).toBe(2)
    expect(result.iteration).toBe(2)
    expect(calls).toContainEqual(['git', 'commit', '--no-edit'])
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
