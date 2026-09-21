import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from './async-queue.ts'
import { Config } from './config.ts'
import type { CreatePrOptions, PrComment, PrDriver, PrState, PullRequest } from './drivers/pr.ts'
import type {
  AgentOutcome,
  AgentProcess,
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
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  heartbeats = 0
  leaseAlive = true
  /** Returned by get() in place of the null default, to simulate a re-read. */
  freshTask: TrackerTask | null = null

  constructor(private queue: TrackerTask[] = []) {}

  async ready(): Promise<TrackerTask[]> {
    return this.queue
  }
  async claim(): Promise<TrackerTask | null> {
    return this.queue.shift() ?? null
  }
  async get(): Promise<TrackerTask | null> {
    return this.freshTask
  }
  async createTask(_input: CreateTrackerTask): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async updateTask(_id: string, _input: UpdateTrackerTask): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async heartbeat(): Promise<boolean> {
    this.heartbeats++
    return this.leaseAlive
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(_id: string): Promise<void> {}
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
  readonly calls: { resumeFrom: string | null; prompt: string; cwd: string }[] = []

  constructor(private readonly turns: Turn[]) {}

  start(opts: AgentStartOptions): AgentProcess {
    return this.run(null, opts)
  }
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.run(sessionId, opts)
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }

  private run(resumeFrom: string | null, opts: AgentStartOptions): AgentProcess {
    this.calls.push({ resumeFrom, prompt: opts.prompt, cwd: opts.cwd })
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

/** An agent process that stays running until killed, so a cancel can interrupt it. */
class BlockingHarness implements Harness {
  readonly kind = 'fake'
  starts = 0
  kills = 0
  private process: AgentProcess | null = null

  start(opts: AgentStartOptions): AgentProcess {
    this.starts++
    let resolveDone!: (o: AgentOutcome) => void
    const done = new Promise<AgentOutcome>((resolve) => {
      resolveDone = resolve
    })
    const queue = new AsyncQueue<AgentEvent>()
    this.process = {
      pid: 12345,
      events: () => queue,
      done,
      kill: async () => {
        this.kills++
        queue.close()
        resolveDone({
          exitCode: 130,
          ok: false,
          sessionId: null,
          summary: null,
          usage: null,
          stderr: 'killed',
        })
      },
      model: null,
      effort: opts.effort ?? null,
    }
    return this.process
  }

  resume(): AgentProcess {
    throw new Error('no resume expected in the cancel test')
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
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

  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }

  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
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

const states = (taskId: string): (string | null | undefined)[] =>
  store
    .events({ taskId, limit: 999 })
    .filter((e) => e.type === 'task.state')
    .map((e) => (e as Extract<StoredEvent, { type: 'task.state' }>).to)

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
    expect(pr.calls[0]?.body).toContain('## ✨ Add a greeting file')
    expect(pr.calls[0]?.body).toContain('**Task:** `bd-a1b2`')
    expect(pr.calls[0]?.body).toContain('Write `hello.txt`')
    expect(pr.calls[0]?.body).toContain('- `hello.txt` +1 -0')
    expect(pr.calls[0]?.base).toBe('main')
    expect(pr.calls[0]?.branch).toContain('amagi/')
    const created = store.events({ taskId: TASK.id }).find((e) => e.type === 'pr.created')
    expect(created?.type === 'pr.created' && created.url).toBe('https://example.com/demo/pull/7')
  })

  test('the PR body carries the implement run model and effort', async () => {
    const pr = new FakePr()
    await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([{ ...writesAFile, model: 'claude-sonnet-5', effort: 'high' }]),
      config(),
      pr,
    ).runOnce()

    expect(pr.calls[0]?.body).toContain(
      '<sub>Generated by amagi · fake · claude-sonnet-5 · effort high</sub>',
    )
  })

  test('builds the PR body from a re-fetched task description', async () => {
    const tracker = new FakeTracker([TASK])
    tracker.freshTask = { ...TASK, description: 'Write hello.txt\n\n### How to use\n\nRun `hello`' }
    const pr = new FakePr()
    await makeRunner(tracker, new FakeHarness([writesAFile]), config(), pr).runOnce()

    expect(pr.calls[0]?.body).toContain('### 🚀 How to use')
    expect(pr.calls[0]?.body).toContain('Run `hello`')
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

  test('an agent that changes nothing lands in no_pr with its summary as the reason', async () => {
    const harness = new FakeHarness([
      { outcome: { summary: 'already implemented upstream: nothing to do' } },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()
    expect(result?.state).toBe('no_pr')
    expect(types(TASK.id)).not.toContain('commit.created')
    const stateEvent = store
      .events({ taskId: TASK.id, limit: 999 })
      .find((e) => e.type === 'task.state' && e.to === 'no_pr')
    expect(stateEvent?.type === 'task.state' && stateEvent.reason).toContain(
      'already implemented upstream',
    )
  })

  test('no_pr asks the agent why when it left no summary and uses that as the reason', async () => {
    const harness = new FakeHarness([
      { outcome: { summary: null } },
      { outcome: { summary: 'already handled by a sibling task; nothing to do here' } },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()
    expect(result?.state).toBe('no_pr')
    expect(types(TASK.id)).not.toContain('commit.created')
    const stateEvent = store
      .events({ taskId: TASK.id, limit: 999 })
      .find((e) => e.type === 'task.state' && e.to === 'no_pr')
    expect(stateEvent?.type === 'task.state' && stateEvent.reason).toContain(
      'already handled by a sibling task',
    )
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    expect(harness.calls[1]?.prompt).toContain('no changes')
  })

  test('no_pr falls back to the canned reason when there is no session to ask', async () => {
    const harness = new FakeHarness([{ outcome: { summary: null, sessionId: null } }])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()
    expect(result?.state).toBe('no_pr')
    const stateEvent = store
      .events({ taskId: TASK.id, limit: 999 })
      .find((e) => e.type === 'task.state' && e.to === 'no_pr')
    expect(stateEvent?.type === 'task.state' && stateEvent.reason).toContain('no changes')
    expect(harness.calls).toHaveLength(1)
  })

  test('an agent that already committed its own work lands in pr_open, not no_pr', async () => {
    const harness = new FakeHarness([
      {
        effect: (cwd) => {
          writeFileSync(join(cwd, 'hello.txt'), 'hi\n')
          Bun.spawnSync(['git', 'add', '-A'], { cwd })
          expect(Bun.spawnSync(['git', 'commit', '-q', '-m', 'agent work'], { cwd }).exitCode).toBe(
            0,
          )
        },
        events: [{ kind: 'text', text: 'wrote and committed hello.txt' }],
      },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(types(TASK.id)).toContain('commit.created')
    const worktree = store.task(TASK.id)?.worktree ?? ''
    const log = await execOk(exec, ['git', 'log', '--oneline', '-1'], { cwd: worktree })
    expect(log).toContain('agent work')
  })

  test('a reclaimed task reuses the recorded worktree and branch', async () => {
    const wtPath = join(wtRoot, 'resume-worktree')
    const branch = 'amagi/bd-a1b2-add-a-greeting-file'
    await execOk(exec, ['git', 'worktree', 'add', '-b', branch, wtPath, 'main'], { cwd: repo })

    store.append(TASK.id, { type: 'task.claimed', title: TASK.title, tracker: 'fake' })
    store.append(TASK.id, { type: 'worktree.created', path: wtPath, branch })
    store.append(TASK.id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(TASK.id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(TASK.id, { type: 'task.reclaimed' })

    const harness = new FakeHarness([writesAFile])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.calls[0]?.cwd).toBe(wtPath)
    expect(harness.calls[0]?.prompt).toContain('resumed')
    expect(harness.calls[0]?.prompt).toContain('continue')
    expect(store.task(TASK.id)?.worktree).toBe(wtPath)
    expect(store.task(TASK.id)?.branch).toBe(branch)
    expect(existsSync(join(wtPath, 'hello.txt'))).toBe(true)
    expect(existsSync(join(wtRoot, 'demo-bd-a1b2-add-a-greeting-file'))).toBe(false)
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
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'model unavailable' } },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(1)
    const errors = store.events({ taskId: TASK.id }).filter((e) => e.type === 'error')
    expect(errors.some((e) => e.type === 'error' && e.message.includes('model unavailable'))).toBe(
      true,
    )
  })

  test('a transient failure backs off and retries, then commits', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'rate limit exceeded' } },
      writesAFile,
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { retryBaseMs: 0, retryMaxMs: 0 } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    const scheduled = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'retry.scheduled' }> => e.type === 'retry.scheduled',
      )
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.attempt).toBe(1)
    expect(scheduled[0]?.delayMs).toBe(0)
    expect(scheduled[0]?.detail).toBe('rate limit exceeded')
    expect(store.task(TASK.id)?.retryCount).toBe(1)
    expect(states(TASK.id)).toContain('retrying')
  })

  test('transient failures escalate only after the retry budget is spent', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'quota exceeded' } },
      { outcome: { ok: false, exitCode: 1, stderr: 'quota exceeded' } },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { maxRetries: 1, retryBaseMs: 0, retryMaxMs: 0 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(2)
    const scheduled = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'retry.scheduled' }> => e.type === 'retry.scheduled',
      )
    expect(scheduled).toHaveLength(1)
    expect(store.task(TASK.id)?.retryCount).toBe(1)
    expect(states(TASK.id)).toContain('retrying')
    expect(types(TASK.id)).not.toContain('commit.created')
  })

  test('an operator-actionable failure escalates without retrying', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'model not installed' } },
      writesAFile,
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(1)
    expect(
      store.events({ taskId: TASK.id }).filter((e) => e.type === 'retry.scheduled'),
    ).toHaveLength(0)
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

describe('Runner.cancel', () => {
  test('kills the agent process, releases the lease, and parks the task in cancelled', async () => {
    const harness = new BlockingHarness()
    const tracker = new FakeTracker([TASK])
    const released: string[] = []
    tracker.release = async (id) => {
      released.push(id)
    }
    const runner = makeRunner(tracker, harness)
    const pending = runner.runOnce()

    await waitFor(() => harness.starts === 1)
    expect(store.task(TASK.id)?.state).toBe('implementing')
    runner.cancel()
    const result = await pending

    expect(harness.kills).toBe(1)
    expect(released).toEqual([TASK.id])
    expect(result?.state).toBe('cancelled')
    expect(store.task(TASK.id)?.state).toBe('cancelled')
    // the recorded worktree survives the stop for the reclaim path
    expect(store.task(TASK.id)?.worktree).not.toBeNull()
    expect(store.task(TASK.id)?.branch).not.toBeNull()
  })

  test('cancelling a parked question releases the lease and parks the task in cancelled', async () => {
    const tracker = new FakeTracker([TASK])
    const released: string[] = []
    tracker.release = async (id) => {
      released.push(id)
    }
    const runner = makeRunner(tracker, new FakeHarness([parksOnQuestion]))
    const pending = runner.runOnce()

    await waitFor(() => store.events({ taskId: TASK.id }).some((e) => e.type === 'question.parked'))
    runner.cancel()
    const result = await pending

    expect(result?.state).toBe('cancelled')
    expect(released).toEqual([TASK.id])
    expect(store.task(TASK.id)?.worktree).not.toBeNull()
  })

  test('cancel interrupts a retry backoff and parks the task in cancelled', async () => {
    const tracker = new FakeTracker([TASK])
    const released: string[] = []
    tracker.release = async (id) => {
      released.push(id)
    }
    const runner = makeRunner(
      tracker,
      new FakeHarness([{ outcome: { ok: false, exitCode: 1, stderr: 'rate limit exceeded' } }]),
      config({ loop: { retryBaseMs: 60_000, retryMaxMs: 60_000 } }),
    )
    const pending = runner.runOnce()

    await waitFor(() => store.events({ taskId: TASK.id }).some((e) => e.type === 'retry.scheduled'))
    runner.cancel()
    const result = await pending

    expect(result?.state).toBe('cancelled')
    expect(released).toEqual([TASK.id])
  })
})
