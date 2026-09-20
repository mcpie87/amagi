import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from './async-queue.ts'
import { Config } from './config.ts'
import type { CreatePrOptions, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type {
  AgentOutcome,
  AgentProcess,
  AgentStartOptions,
  GateRef,
  Harness,
  Question,
  Tracker,
  TrackerStatus,
  TrackerTask,
} from './drivers/types.ts'
import type { AgentEvent, EventType, StoredEvent } from './events.ts'
import { exec, execOk } from './exec.ts'
import { Runner } from './runner.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

const TASK: TrackerTask = {
  id: 'bd-a1b2',
  title: 'Add a greeting file',
  description: 'Write hello.txt',
  status: 'in_progress',
  priority: 1,
  type: 'task',
  url: null,
}

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  heartbeats = 0
  leaseAlive = true

  constructor(private queue: TrackerTask[] = []) {}

  async ready(): Promise<TrackerTask[]> {
    return this.queue
  }
  async claim(): Promise<TrackerTask | null> {
    return this.queue.shift() ?? null
  }
  async get(): Promise<TrackerTask | null> {
    return null
  }
  async heartbeat(): Promise<boolean> {
    this.heartbeats++
    return this.leaseAlive
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(): Promise<void> {}
  async close(): Promise<void> {}
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'gate', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return true
  }
  async resolveGate(): Promise<void> {}
}

type Turn = {
  effect?: (cwd: string) => void
  events?: AgentEvent[]
  outcome?: Partial<AgentOutcome>
  model?: string | null
  effort?: string | null
}

class FakeHarness implements Harness {
  readonly kind = 'fake'
  readonly calls: { resumeFrom: string | null; prompt: string }[] = []

  constructor(private readonly turns: Turn[]) {}

  start(opts: AgentStartOptions): AgentProcess {
    return this.run(null, opts)
  }
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.run(sessionId, opts)
  }

  private run(resumeFrom: string | null, opts: AgentStartOptions): AgentProcess {
    this.calls.push({ resumeFrom, prompt: opts.prompt })
    const turn = this.turns.shift() ?? {}
    turn.effect?.(opts.cwd)

    const queue = new AsyncQueue<AgentEvent>()
    for (const e of turn.events ?? []) queue.push(e)
    queue.close()

    const outcome: AgentOutcome = {
      exitCode: 0,
      ok: true,
      sessionId: 'sess-1',
      summary: 'done',
      usage: null,
      stderr: '',
      ...turn.outcome,
    }
    return {
      pid: -1,
      events: () => queue,
      done: Promise.resolve(outcome),
      kill: async () => {},
      model: turn.model ?? null,
      effort: turn.effort ?? null,
    }
  }
}

class FakePr implements PrDriver {
  readonly calls: CreatePrOptions[] = []
  failWith: Error | null = null

  async createPr(opts: CreatePrOptions): Promise<PullRequest> {
    this.calls.push(opts)
    if (this.failWith !== null) throw this.failWith
    return { url: 'https://example.com/demo/pull/7', number: 7 }
  }

  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
}

let repo: string
let wtRoot: string
let store: Store

const config = (over: Record<string, unknown> = {}) =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: wtRoot },
    checks: { commands: [] },
    ...over,
  })

const makeRunner = (tracker: Tracker, harness: Harness, cfg = config(), forge = new FakePr()) =>
  new Runner({
    store,
    tracker,
    harness,
    config: cfg,
    repoRoot: repo,
    repoName: 'demo',
    forge,
  })

const types = (taskId: string): EventType[] =>
  store.events({ taskId, limit: 999 }).map((e) => e.type)

beforeEach(async () => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  repo = mkdtempSync(join(tmpdir(), 'amagi-run-repo-'))
  wtRoot = mkdtempSync(join(tmpdir(), 'amagi-run-wt-'))
  store = new Store(openDatabase(':memory:'))
  await execOk(exec, ['git', 'init', '-q', '-b', 'main', '.'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.name', 'Test'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.email', 'test@example.com'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  await execOk(exec, ['git', 'add', '.'], { cwd: repo })
  await execOk(exec, ['git', 'commit', '-q', '-m', 'init'], { cwd: repo })
})

afterEach(() => {
  store.close()
  rmSync(repo, { recursive: true, force: true })
  rmSync(wtRoot, { recursive: true, force: true })
})

const writesAFile: Turn = {
  effect: (cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'),
  events: [{ kind: 'text', text: 'wrote hello.txt' }],
}

const waitFor = async (fn: () => boolean, timeoutMs = 2000): Promise<void> => {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const parksOnQuestion: Turn = {
  effect: (cwd) => {
    writeFileSync(join(cwd, 'hello.txt'), 'hi\n')
    store.append(TASK.id, {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which registry?',
      options: ['npm', 'nexus'],
      gateRef: null,
    })
    store.append(TASK.id, { type: 'task.state', from: 'implementing', to: 'awaiting_answer' })
  },
}

describe('Runner.runOnce', () => {
  test('an empty queue is not an error', async () => {
    expect(await makeRunner(new FakeTracker([]), new FakeHarness([])).runOnce()).toBeNull()
  })

  test('drives claim to a pull request and records the whole story', async () => {
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(types(TASK.id)).toEqual([
      'task.claimed',
      'worktree.created',
      'task.state',
      'task.state',
      'agent.started',
      'agent.stream',
      'agent.exited',
      'task.state',
      'checks.finished',
      'commit.created',
      'task.state',
      'pr.created',
      'task.state',
    ])
  })

  test('the agent.started event carries the harness-reported model and effort', async () => {
    await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([{ ...writesAFile, model: 'claude-sonnet-5', effort: 'high' }]),
    ).runOnce()

    const started = store
      .events({ taskId: TASK.id, limit: 999 })
      .find((e): e is Extract<StoredEvent, { type: 'agent.started' }> => e.type === 'agent.started')
    expect(started?.model).toBe('claude-sonnet-5')
    expect(started?.effort).toBe('high')
  })

  test('opens the pull request with the task title and base branch', async () => {
    const pr = new FakePr()
    await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
      config(),
      pr,
    ).runOnce()

    expect(pr.calls).toHaveLength(1)
    expect(pr.calls[0]?.title).toBe('bd-a1b2: Add a greeting file')
    expect(pr.calls[0]?.base).toBe('main')
    expect(pr.calls[0]?.branch).toContain('amagi/')
    const created = store.events({ taskId: TASK.id }).find((e) => e.type === 'pr.created')
    expect(created?.type === 'pr.created' && created.url).toBe('https://example.com/demo/pull/7')
  })

  test('a failed pull request escalates but keeps the commit', async () => {
    const pr = new FakePr()
    pr.failWith = new Error('gh not authenticated')
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
      config(),
      pr,
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(types(TASK.id)).toContain('commit.created')
    expect(types(TASK.id)).not.toContain('pr.created')
    const errors = store.events({ taskId: TASK.id }).filter((e) => e.type === 'error')
    expect(
      errors.some((e) => e.type === 'error' && e.message.includes('gh not authenticated')),
    ).toBe(true)
  })

  test('the commit lands in the worktree branch, not the main checkout', async () => {
    await makeRunner(new FakeTracker([TASK]), new FakeHarness([writesAFile])).runOnce()
    const row = store.task(TASK.id)
    expect(row?.branch).toBe('amagi/bd-a1b2-add-a-greeting-file')

    const log = await execOk(exec, ['git', 'log', '--oneline', '-1'], { cwd: row?.worktree ?? '' })
    expect(log).toContain('Add a greeting file')
    const mainLog = await execOk(exec, ['git', 'log', '--oneline', '-1'], { cwd: repo })
    expect(mainLog).toContain('init')
  })

  test('an agent that changes nothing is escalated, not silently committed', async () => {
    const result = await makeRunner(new FakeTracker([TASK]), new FakeHarness([{}])).runOnce()
    expect(result?.state).toBe('needs_human')
    expect(types(TASK.id)).not.toContain('commit.created')
  })

  test('failing checks are handed back to the same session and then commit', async () => {
    const harness = new FakeHarness([
      { effect: (cwd) => writeFileSync(join(cwd, 'flag'), 'bad\n') },
      { effect: (cwd) => writeFileSync(join(cwd, 'flag'), 'good\n') },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ checks: { commands: ['grep -q good flag'] } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    expect(harness.calls[1]?.prompt).toContain('grep -q good flag')
    expect(harness.calls[1]?.prompt).toContain('checks failed')
  })

  test('checks that never pass end in needs_human', async () => {
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile, {}, {}]),
      config({ checks: { commands: ['false'] }, loop: { maxCheckRounds: 1 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(store.task(TASK.id)?.state).toBe('needs_human')
  })

  test('checks stop at the first failure rather than running the rest', async () => {
    await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile, {}, {}]),
      config({ checks: { commands: ['false', 'true'] }, loop: { maxCheckRounds: 0 } }),
    ).runOnce()

    const finished = store.events({ taskId: TASK.id }).find((e) => e.type === 'checks.finished')
    expect(finished?.type === 'checks.finished' && finished.results).toHaveLength(1)
  })

  test('a crashing agent still leaves an auditable trail', async () => {
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([{ outcome: { ok: false, exitCode: 1, stderr: 'model unavailable' } }]),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    const errors = store.events({ taskId: TASK.id }).filter((e) => e.type === 'error')
    expect(errors.some((e) => e.type === 'error' && e.message.includes('model unavailable'))).toBe(
      true,
    )
  })

  test('an unusable base branch escalates instead of throwing out of runOnce', async () => {
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
      config({ repo: { baseBranch: 'no-such-branch', worktreeRoot: wtRoot } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(store.task(TASK.id)?.lastError).toBeTruthy()
  })

  test('parks on an unanswered question and resumes the session with the answer', async () => {
    const harness = new FakeHarness([
      parksOnQuestion,
      { effect: (cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi answer\n') },
    ])
    const pending = makeRunner(new FakeTracker([TASK]), harness).runOnce()

    await waitFor(() => store.events({ taskId: TASK.id }).some((e) => e.type === 'question.parked'))
    store.append(TASK.id, {
      type: 'question.answered',
      questionId: 'q1',
      answer: 'npm',
      via: 'web',
    })
    store.append(TASK.id, { type: 'task.state', from: 'awaiting_answer', to: 'implementing' })

    const result = await pending
    expect(result?.state).toBe('pr_open')
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    expect(harness.calls[1]?.prompt).toContain('which registry?')
    expect(harness.calls[1]?.prompt).toContain('npm')
    expect(types(TASK.id)).toContain('question.parked')
  })

  test('escalates to needs_human when the answer never lands', async () => {
    const harness = new FakeHarness([parksOnQuestion])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { questionParkTimeoutSec: 1 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(store.task(TASK.id)?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(1)
    expect(types(TASK.id)).toContain('question.parked')
    const lastState = store
      .events({ taskId: TASK.id })
      .filter((e) => e.type === 'task.state')
      .at(-1)
    expect(lastState?.type === 'task.state' && lastState.to).toBe('needs_human')
  })
})
