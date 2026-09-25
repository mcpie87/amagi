import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type {
  AgentOutcome,
  AgentStartOptions,
  CreateTrackerTask,
  GateRef,
  Harness,
  Question,
  Tracker,
  TrackerCapabilities,
  TrackerStatus,
  TrackerTask,
  UpdateTrackerTask,
} from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  isAgentMention,
  listPrMentions,
  type MentionClassified,
  type MentionProgress,
  mentionsPath,
  parseMentionKind,
  readHandledMentions,
  resolveTaskId,
  respondToMention,
  saveHandledMentions,
  taskIdFromPrTitle,
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

class FakeDriver implements PrDriver {
  comments: PrComment[] = []
  readonly posted: string[] = []

  async createPr(_opts: CreatePrOptions): Promise<PullRequest> {
    throw new Error('unused')
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async listOpenPrs(_cwd: string): Promise<PrInfo[]> {
    throw new Error('unused')
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async getPrDiff(_cwd: string, _number: number): Promise<string> {
    return ''
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return this.comments
  }
  async postComment(_cwd: string, _number: number, body: string): Promise<void> {
    this.posted.push(body)
  }
  async closePr(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async deleteBranch(): Promise<void> {}
}

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly capabilities: TrackerCapabilities = { create: true, edit: false, dependencies: false }
  readonly leaseTtlMs = 60_000
  readonly comments: Array<[string, string]> = []

  async ready(_limit?: number): Promise<never[]> {
    return []
  }
  async claim(_id?: string): Promise<null> {
    return null
  }
  async get(id: string) {
    return {
      id,
      title: id,
      description: '',
      status: 'open' as TrackerStatus,
      priority: null,
      type: null,
      url: null,
    }
  }
  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    return {
      id: 'bd-new',
      title: input.title,
      description: input.description,
      status: 'open',
      priority: null,
      type: null,
      url: null,
    }
  }
  async updateTask(_id: string, _input: UpdateTrackerTask): Promise<TrackerTask> {
    throw new Error('unused')
  }
  async heartbeat(_id: string): Promise<boolean> {
    return true
  }
  async comment(id: string, body: string): Promise<void> {
    this.comments.push([id, body])
  }
  async setStatus(_id: string, _status: TrackerStatus): Promise<void> {}
  async release(_id: string): Promise<void> {}
  async close(_id: string, _reason?: string): Promise<void> {}
  async openGate(_taskId: string, _question: Question): Promise<GateRef> {
    return { id: 'gate', advisory: false }
  }
  async gateResolved(_ref: GateRef): Promise<boolean> {
    return true
  }
  async resolveGate(_ref: GateRef): Promise<void> {}
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

function summaryHarness(
  summary: string,
  outPath: string,
  over: Partial<AgentOutcome> = {},
): Harness {
  const base = fakeHarness({ summary: 'fix-pr', ...over })
  return {
    ...base,
    start: (opts: AgentStartOptions) => {
      if (opts.cwd !== tmpdir()) writeFileSync(outPath, summary)
      return base.start(opts)
    },
  }
}

const config = () =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    checks: { commands: [], format: null, lint: null },
  })

describe('parseMentionKind', () => {
  test('recognises each category, case-insensitively', () => {
    expect(parseMentionKind('fix-pr')).toBe('fix-pr')
    expect(parseMentionKind('FIX-PR')).toBe('fix-pr')
    expect(parseMentionKind('explain')).toBe('explain')
    expect(parseMentionKind('add-a-task')).toBe('add-a-task')
    expect(parseMentionKind('take-down')).toBe('take-down')
    expect(parseMentionKind('ambiguous')).toBe('ambiguous')
  })

  test('falls back to ambiguous for anything unrecognised', () => {
    expect(parseMentionKind('')).toBe('ambiguous')
    expect(parseMentionKind('sure, go ahead')).toBe('ambiguous')
    expect(parseMentionKind('I would classify this as: fix-pr')).toBe('ambiguous')
    expect(parseMentionKind('not fix-pr, this is explain')).toBe('ambiguous')
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

describe('isAgentMention', () => {
  test('matches the handle case-insensitively, ignores the agent itself and non-mentions', () => {
    expect(isAgentMention({ id: '1', user: 'bob', body: '@chise-maru fix it' }, 'chise-maru')).toBe(
      true,
    )
    expect(
      isAgentMention({ id: '2', user: 'alice', body: 'why, @Chise-Maru?' }, 'chise-maru'),
    ).toBe(true)
    expect(
      isAgentMention({ id: '3', user: 'chise-maru', body: '@chise-maru self' }, 'chise-maru'),
    ).toBe(false)
    expect(isAgentMention({ id: '4', user: 'bob', body: 'no mention' }, 'chise-maru')).toBe(false)
  })

  test('matches the PR #102 relevance question, which is a mention but not a fix request', () => {
    expect(
      isAgentMention(
        {
          id: '5768283300',
          user: 'mcpie87',
          body: '@chise-maru is still change still relevant compared to current repo state?',
        },
        'chise-maru',
      ),
    ).toBe(true)
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
  test('a fix-pr mention posts its summary after pushing to the PR head', async () => {
    let reflogCalls = 0
    const order: string[] = []
    const cfg = config()
    cfg.watchers.mention.model = 'gpt-5'
    cfg.watchers.mention.effort = 'high'
    const { exec, calls } = fake((c) => {
      if (c.includes('reflog')) {
        reflogCalls++
        return {
          exitCode: 0,
          stdout:
            reflogCalls === 1
              ? 'aaa checkout: initial\n'
              : 'bbb reset: unexpected\naaa checkout: initial\n',
          stderr: '',
        }
      }
      if (c[1] === 'status') return { exitCode: 0, stdout: ' M src/fix.ts\n', stderr: '' }
      if (c[1] === 'push') order.push('push')
      return c.includes('rev-parse') ? fail('') : undefined
    })
    const driver = new FakeDriver()
    driver.postComment = async (_cwd, _number, body) => {
      order.push('comment')
      driver.posted.push(body)
    }
    const bypassed: string[][] = []
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '1', user: 'bob', body: 'this logic is wrong' },
      config: cfg,
      driver,
      exec,
      makeHarnessFn: () =>
        summaryHarness('Fixed the parser edge case.', join(tmpdir(), 'amagi-fix-pr-7-1.md')),
      onGitBypassed: (entries) => bypassed.push(entries),
    })

    expect(kind).toBe('fix-pr')
    expect(calls).toContainEqual(['git', 'merge', 'origin/main'])
    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
    expect(driver.posted).toEqual([
      '@bob Fixed the parser edge case.\n\n---\n\n<sub>Generated by amagi · claude · gpt-5 · effort high</sub>',
    ])
    expect(order).toEqual(['push', 'comment'])
    expect(calls).toContainEqual(['git', 'commit', '-q', '-F', '-'])
    expect(bypassed).toEqual([['bbb reset: unexpected']])
  })

  test('a clean fix-pr mention posts the reason without committing', async () => {
    const { exec, calls } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: 'clean', user: 'alice', body: 'is this necessary?' },
      config: config(),
      driver,
      exec,
      makeHarnessFn: () =>
        summaryHarness(
          'The existing parser already handles this case.',
          join(tmpdir(), 'amagi-fix-pr-7-clean.md'),
        ),
    })

    expect(kind).toBe('fix-pr')
    expect(calls.some((c) => c[1] === 'commit')).toBe(false)
    expect(driver.posted).toEqual([
      '@alice No change was made: The existing parser already handles this case.',
    ])
  })

  test('a failed fix push posts no comment', async () => {
    const { exec } = fake((c) => {
      if (c.includes('rev-parse')) return fail('')
      if (c[1] === 'status') return { exitCode: 0, stdout: ' M src/fix.ts\n', stderr: '' }
      if (c[1] === 'push') return fail('push rejected')
      return undefined
    })
    const driver = new FakeDriver()
    await expect(
      respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr(),
        mention: { id: 'push-failed', user: 'bob', body: 'fix this' },
        config: config(),
        driver,
        exec,
        makeHarnessFn: () =>
          summaryHarness(
            'Fixed the parser edge case.',
            join(tmpdir(), 'amagi-fix-pr-7-push-failed.md'),
          ),
      }),
    ).rejects.toThrow()

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

  test('an explain mention reports a conflicted base merge as evidence in the prompt', async () => {
    const outPath = join(tmpdir(), `amagi-explain-7-10.md`)
    writeFileSync(outPath, 'It drifts from base.\n')
    const { exec } = fake((c) => {
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      return undefined
    })
    const driver = new FakeDriver()
    const prompts: string[] = []
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '10', user: 'bob', body: 'is this still relevant?' },
      config: config(),
      driver,
      exec,
      makeHarnessFn: (_cfg) => {
        const base = fakeHarness({ summary: 'explain' })
        return {
          ...base,
          start: (opts: AgentStartOptions) => {
            prompts.push(opts.prompt)
            return base.start(opts)
          },
        }
      },
    })

    expect(kind).toBe('explain')
    expect(prompts.join('\n')).toContain('does not merge cleanly into this PR')
    expect(prompts.join('\n')).toContain('drift')
  })

  test('classification uses the mention watcher harness overrides', async () => {
    const cfg = config()
    cfg.harness.implement.model = 'base-model'
    cfg.watchers.mention.kind = 'codex'
    cfg.watchers.mention.model = 'mention-model'
    cfg.watchers.mention.effort = 'high'
    cfg.watchers.mention.seat = 'mention-seat'
    let startedWith: ReturnType<typeof config>['harness']['implement'] | undefined
    await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: 'watcher-config', user: 'bob', body: 'what should happen?' },
      config: cfg,
      driver: new FakeDriver(),
      makeHarnessFn: (harnessConfig) => {
        startedWith = harnessConfig
        return fakeHarness({ summary: 'ambiguous' })
      },
    })
    expect(startedWith).toMatchObject({
      kind: 'codex',
      model: 'mention-model',
      effort: 'high',
      seat: 'mention-seat',
    })
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

  test('a TAKE DOWN verdict posts the reason on the tracker issue and replies on the PR', async () => {
    const outPath = join(tmpdir(), 'amagi-takedown-7-1.md')
    writeFileSync(
      outPath,
      'TAKE DOWN\nThis PR reverses the base behavior and breaks existing callers.\n',
    )
    const { exec } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    const tracker = new FakeTracker()
    try {
      const kind = await respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr({ title: 'am-123: Do the thing' }),
        mention: { id: '1', user: 'bob', body: 'take this PR down' },
        config: config(),
        driver,
        tracker,
        exec,
        makeHarnessFn: () => fakeHarness({ summary: 'take-down' }),
      })

      expect(kind).toBe('take-down')
      expect(driver.posted).toEqual([
        'This PR reverses the base behavior and breaks existing callers.',
      ])
      expect(tracker.comments).toEqual([
        ['am-123', 'This PR reverses the base behavior and breaks existing callers.'],
      ])
    } finally {
      rmSync(outPath, { force: true })
    }
    expect(existsSync(outPath)).toBe(false)
  })

  test('a KEEP verdict replies on the PR but does not comment on the tracker', async () => {
    const outPath = join(tmpdir(), 'amagi-takedown-7-2.md')
    writeFileSync(outPath, 'KEEP\nThe conflicts are trivial and the PR is fine.\n')
    const { exec } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    const tracker = new FakeTracker()
    try {
      const kind = await respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr({ title: 'am-123: Do the thing' }),
        mention: { id: '2', user: 'bob', body: 'take this PR down' },
        config: config(),
        driver,
        tracker,
        exec,
        makeHarnessFn: () => fakeHarness({ summary: 'take-down' }),
      })

      expect(kind).toBe('take-down')
      expect(driver.posted).toEqual(['The conflicts are trivial and the PR is fine.'])
      expect(tracker.comments).toEqual([])
    } finally {
      rmSync(outPath, { force: true })
    }
  })

  test('take-down without a tracker or task id still replies on the PR', async () => {
    const outPath = join(tmpdir(), 'amagi-takedown-7-3.md')
    writeFileSync(outPath, 'TAKE DOWN\nThe PR duplicates existing functionality.\n')
    const { exec } = fake((c) => (c.includes('rev-parse') ? fail('') : undefined))
    const driver = new FakeDriver()
    try {
      const kind = await respondToMention({
        root: '/repo',
        repoName: 'amagi',
        pr: pr({ title: 'Not an amagi PR' }),
        mention: { id: '3', user: 'bob', body: 'take this PR down' },
        config: config(),
        driver,
        exec,
        makeHarnessFn: () => fakeHarness({ summary: 'take-down' }),
      })

      expect(kind).toBe('take-down')
      expect(driver.posted).toEqual(['The PR duplicates existing functionality.'])
    } finally {
      rmSync(outPath, { force: true })
    }
  })
})

describe('taskIdFromPrTitle', () => {
  test('extracts the amagi task id from a PR title', () => {
    expect(taskIdFromPrTitle('am-544: PR titles should use task code')).toBe('am-544')
    expect(taskIdFromPrTitle('am-3b8.2: Schema-constrained review')).toBe('am-3b8.2')
    expect(taskIdFromPrTitle('Do the thing')).toBeNull()
  })
})

describe('resolveTaskId', () => {
  test('prefers the amagi-task body trailer over everything else', async () => {
    const tracker = new FakeTracker()
    const taskId = await resolveTaskId(
      pr({ title: 'Not an amagi PR', headRefName: 'feature/manual', body: 'amagi-task: am-9ml' }),
      tracker,
    )
    expect(taskId).toBe('am-9ml')
  })

  test('falls back to the branch name matched against the tracker open ids', async () => {
    const tracker = Object.assign(new FakeTracker(), {
      async openIds() {
        return ['am-3b8', 'am-9ml']
      },
    })
    const taskId = await resolveTaskId(
      pr({
        title: 'Not an amagi PR',
        body: '',
        headRefName: 'amagi/am-3b8-schema-constrained-review',
      }),
      tracker,
    )
    expect(taskId).toBe('am-3b8')
  })

  test('falls back to the PR title when the body and branch name give nothing', async () => {
    const tracker = new FakeTracker()
    const taskId = await resolveTaskId(
      pr({ title: 'am-123: Do the thing', body: '', headRefName: 'amagi/am-1-do-the-thing' }),
      tracker,
    )
    expect(taskId).toBe('am-123')
  })

  test('is null when no source names a task', async () => {
    const tracker = new FakeTracker()
    const taskId = await resolveTaskId(
      pr({ title: 'Not an amagi PR', body: '', headRefName: 'feature/manual' }),
      tracker,
    )
    expect(taskId).toBeNull()
  })
})

describe('respondToMention progress', () => {
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

  test('reports the chosen kind and the raw classifier reply', async () => {
    const reply = "Hmm, I'd say this is ambiguous, please clarify"
    const proc = {
      pid: -1,
      events: async function* () {},
      done: Promise.resolve({
        exitCode: 0,
        ok: true,
        sessionId: null,
        summary: reply,
        usage: null,
        stderr: '',
      } satisfies AgentOutcome),
      kill: async () => {},
      model: null,
      effort: null,
    }
    const driver = new FakeDriver()
    const classified: MentionClassified[] = []
    const kind = await respondToMention({
      root: '/repo',
      repoName: 'amagi',
      pr: pr(),
      mention: { id: '9', user: 'bob', body: 'what should I do with this?' },
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
      onClassified: (c) => classified.push(c),
    })

    expect(kind).toBe('ambiguous')
    expect(classified).toEqual([{ kind: 'ambiguous', reply }])
  })
})
