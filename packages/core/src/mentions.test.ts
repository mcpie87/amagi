import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type {
  AgentOutcome,
  CreateTrackerTask,
  Harness,
  Tracker,
  TrackerCapabilities,
  TrackerTask,
} from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  listPrMentions,
  type MentionProgress,
  mentionsPath,
  parseMentionKind,
  readHandledMentions,
  respondToMention,
  saveHandledMentions,
} from './mentions.ts'
import type { PrInfo } from './pr-check.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  ...over,
})

class FakeDriver implements PrDriver {
  comments: PrComment[] = []
  readonly posted: string[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    throw new Error('unused')
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return this.comments
  }
  async postComment(_cwd: string, _number: number, body: string): Promise<void> {
    this.posted.push(body)
  }
}

/** Tracker stub recording createTask calls, for the add-a-task response. */
function fakeTracker(create: boolean): Tracker & { created: CreateTrackerTask[] } {
  const capabilities: TrackerCapabilities = { create, edit: false, dependencies: false }
  const tracker = {
    kind: 'fake',
    capabilities,
    created: [] as CreateTrackerTask[],
    async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
      tracker.created.push(input)
      return {
        id: 'bd-new',
        title: input.title,
        description: input.description,
        status: 'open',
        priority: null,
        type: null,
        url: null,
      }
    },
  } as unknown as Tracker & { created: CreateTrackerTask[] }
  return tracker
}

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

const emptyEvents = async function* (): AsyncGenerator<never> {}

function fakeHarness(
  over: Partial<AgentOutcome> = {},
  procOver: { model?: string | null; effort?: string | null } = {},
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
    model: procOver.model ?? null,
    effort: procOver.effort ?? null,
  }
  return {
    kind: 'fake',
    start: () => process,
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

const config = () =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    checks: { commands: [] },
  })

describe('parseMentionKind', () => {
  test('recognises each category, case-insensitively', () => {
    expect(parseMentionKind('fix-pr')).toBe('fix-pr')
    expect(parseMentionKind('FIX-PR')).toBe('fix-pr')
    expect(parseMentionKind('explain')).toBe('explain')
    expect(parseMentionKind('add-a-task')).toBe('add-a-task')
    expect(parseMentionKind('ambiguous')).toBe('ambiguous')
  })

  test('falls back to ambiguous for anything unrecognised', () => {
    expect(parseMentionKind('')).toBe('ambiguous')
    expect(parseMentionKind('sure, go ahead')).toBe('ambiguous')
    expect(parseMentionKind('I would classify this as: fix-pr')).toBe('fix-pr')
  })
})

describe('handled mentions', () => {
  test('roundtrips through a json file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-mentions-'))
    try {
      const path = join(dir, 'mentions.json')
      expect(readHandledMentions(path).size).toBe(0)
      saveHandledMentions(path, new Set(['1', '2']))
      expect(readHandledMentions(path)).toEqual(new Set(['1', '2']))
      expect(existsSync(mentionsPath('demo'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('mentionsPath lives under the amagi cache', () => {
    expect(mentionsPath('amagi')).toContain('amagi/mentions/amagi.json')
  })
})

describe('listPrMentions', () => {
  test('keeps human mentions of the handle, drops the agent and non-mentions', async () => {
    const driver = new FakeDriver()
    driver.comments = [
      { id: '1', user: 'bob', body: '@chise-maru remove this file' },
      { id: '2', user: 'chise-maru', body: '@chise-maru self mention' },
      { id: '3', user: 'bob', body: 'no handle here' },
      { id: '4', user: 'alice', body: 'Why did you add this, @Chise-Maru?' },
    ]
    const mentions = await listPrMentions({
      driver,
      cwd: '/repo',
      pr: pr(),
      handle: 'chise-maru',
    })

    expect(mentions.map((m) => m.id)).toEqual(['1', '4'])
  })
})

describe('respondToMention', () => {
  test('a fix-pr mention runs the agent in a worktree and pushes to the PR head', async () => {
    const { exec, calls } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '1', user: 'bob', body: 'this logic is wrong' },
      config: config(),
      driver,
      exec,
      makeHarnessFn: () => fakeHarness({ summary: 'fix-pr' }),
    })

    expect(kind).toBe('fix-pr')
    expect(calls).toContainEqual(['git', 'merge', 'origin/main'])
    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
    expect(driver.posted).toHaveLength(0)
  })

  test('an explain mention posts the agent explanation as a comment', async () => {
    const outPath = join(tmpdir(), `amagi-explain-7-9.md`)
    writeFileSync(outPath, 'Because the old parser dropped unicode.\n')
    const { exec } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '9', user: 'bob', body: 'why did you make these changes' },
      config: config(),
      driver,
      exec,
      makeHarnessFn: () => fakeHarness({ summary: 'explain' }, { model: 'gpt-5', effort: 'high' }),
    })

    expect(kind).toBe('explain')
    expect(driver.posted).toEqual([
      'Because the old parser dropped unicode.\n\n---\n\n<sub>Generated by amagi · claude · gpt-5 · effort high</sub>',
    ])
    expect(existsSync(outPath)).toBe(false)
  })

  test('an add-a-task mention creates a tracker task and posts a confirmation', async () => {
    const tracker = fakeTracker(true)
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '4', user: 'bob', body: 'please track adding tests for this' },
      config: config(),
      driver,
      tracker,
      makeHarnessFn: () => fakeHarness({ summary: 'add-a-task' }),
    })

    expect(kind).toBe('add-a-task')
    expect(tracker.created).toHaveLength(1)
    expect(tracker.created[0]?.title).toContain('PR #7:')
    expect(tracker.created[0]?.description).toContain('@bob')
    expect(driver.posted).toEqual(['@bob Logged this as task bd-new.'])
  })

  test('an add-a-task mention without a task-capable tracker explains it cannot', async () => {
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '4', user: 'bob', body: 'please track this' },
      config: config(),
      driver,
      tracker: fakeTracker(false),
      makeHarnessFn: () => fakeHarness({ summary: 'add-a-task' }),
    })

    expect(kind).toBe('add-a-task')
    expect(driver.posted[0]).toContain("can't create issues")
  })

  test('an ambiguous mention asks for clarification and does not dispatch', async () => {
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '3', user: 'bob', body: 'hmm, not sure about this' },
      config: config(),
      driver,
      makeHarnessFn: () => fakeHarness({ summary: 'ambiguous' }),
    })

    expect(kind).toBe('ambiguous')
    expect(driver.posted).toHaveLength(1)
    expect(driver.posted[0]).toContain('@bob')
    expect(driver.posted[0]).toContain('clarify')
  })

  test('a failed classifier throws so the mention is not marked handled', async () => {
    const driver = new FakeDriver()
    await expect(
      respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr(),
        mention: { id: '1', user: 'bob', body: 'this logic is wrong' },
        config: config(),
        driver,
        makeHarnessFn: () =>
          fakeHarness({
            exitCode: 1,
            ok: false,
            sessionId: null,
            summary: null,
            usage: null,
            stderr: 'boom',
          }),
      }),
    ).rejects.toThrow('boom')
  })

  test('reports live progress with phases, tool use, and usage', async () => {
    async function* events() {
      yield { kind: 'tool_use' as const, name: 'bun test', input: {} }
      yield {
        kind: 'usage' as const,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
        costUsd: 0.01,
      }
    }
    const proc = {
      pid: -1,
      events: () => events(),
      done: Promise.resolve({
        exitCode: 0,
        ok: true,
        sessionId: null,
        summary: 'explain',
        usage: null,
        stderr: '',
      } satisfies AgentOutcome),
      kill: async () => {},
      model: null,
      effort: null,
    }
    const outPath = join(tmpdir(), `amagi-explain-7-9.md`)
    writeFileSync(outPath, 'Because the old parser dropped unicode.\n')
    const driver = new FakeDriver()
    const progress: MentionProgress[] = []
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '9', user: 'bob', body: 'why did you make these changes' },
      config: config(),
      driver,
      exec: fake((c) => (c.includes('rev-parse') ? fail('') : undefined)).exec,
      makeHarnessFn: () => ({
        kind: 'fake',
        start: () => proc,
        resume: () => proc,
        listModels: async () => [],
        listEfforts: async () => [],
      }),
      onProgress: (p) => progress.push(p),
    })

    expect(kind).toBe('explain')
    const phases = progress.map((p) => p.phase)
    expect(phases).toContain('classifying')
    expect(phases).toContain('explaining')
    expect(progress.some((p) => p.tool === 'bun test')).toBe(true)
    expect(progress.some((p) => p.usage?.inputTokens === 100)).toBe(true)
    for (const p of progress) {
      expect(p.phaseMs).toBeGreaterThanOrEqual(0)
      expect(p.totalMs).toBeGreaterThanOrEqual(p.phaseMs)
    }
  })
})
