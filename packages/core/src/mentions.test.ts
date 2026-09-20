import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type { AgentOutcome, Harness } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  classifyMention,
  listPrMentions,
  mentionsPath,
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
  outcome: AgentOutcome = {
    exitCode: 0,
    ok: true,
    sessionId: null,
    summary: 'done',
    usage: null,
    stderr: '',
  },
): Harness {
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
    start: () => process,
    resume: () => process,
    listModels: async () => [],
  }
}

const config = () =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    checks: { commands: [] },
  })

describe('classifyMention', () => {
  test('fix requests', () => {
    expect(classifyMention('this file should not be there, remove it')).toBe('fix')
    expect(classifyMention('this logic is wrong')).toBe('fix')
    expect(classifyMention('address the review comments')).toBe('fix')
    expect(classifyMention('please fix the broken test')).toBe('fix')
  })

  test('explain requests', () => {
    expect(classifyMention('why did you make these changes')).toBe('explain')
    expect(classifyMention('why did you add X')).toBe('explain')
    expect(classifyMention('please explain the rationale')).toBe('explain')
  })

  test('ambiguous when neither', () => {
    expect(classifyMention('nice work!')).toBe('ambiguous')
    expect(classifyMention('hello')).toBe('ambiguous')
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
  test('a fix mention runs the agent in a worktree and pushes to the PR head', async () => {
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
      makeHarnessFn: () => fakeHarness(),
    })

    expect(kind).toBe('fix')
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
      makeHarnessFn: () => fakeHarness(),
    })

    expect(kind).toBe('explain')
    expect(driver.posted).toEqual(['Because the old parser dropped unicode.'])
    expect(existsSync(outPath)).toBe(false)
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
      makeHarnessFn: () => fakeHarness(),
    })

    expect(kind).toBe('ambiguous')
    expect(driver.posted).toHaveLength(1)
    expect(driver.posted[0]).toContain('@bob')
    expect(driver.posted[0]).toContain('clarify')
  })

  test('a failed agent throws so the mention is not marked handled', async () => {
    const { exec } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    await expect(
      respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr(),
        mention: { id: '1', user: 'bob', body: 'this logic is wrong' },
        config: config(),
        driver,
        exec,
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
})
