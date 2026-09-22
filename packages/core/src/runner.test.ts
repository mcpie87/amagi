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
import { type Exec, exec, execOk } from './exec.ts'
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

  constructor(public queue: TrackerTask[] = []) {}

  async ready(): Promise<TrackerTask[]> {
    return this.queue
  }
  async claim(id?: string): Promise<TrackerTask | null> {
    if (id !== undefined) return this.queue.find((t) => t.id === id) ?? null
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
  readonly kind: string
  readonly calls: { resumeFrom: string | null; prompt: string; cwd: string }[] = []
  kills = 0

  constructor(
    private readonly turns: Turn[],
    kind = 'fake',
  ) {
    this.kind = kind
  }

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
      kill: async () => {
        this.kills++
      },
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

  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }

  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }

  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
}

let repo: string
let wtRoot: string
let store: Store

const config = ({ checks, ...rest }: Record<string, unknown> = {}) =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: wtRoot },
    // No formatter/lint tooling in the fake worktrees, so the mandatory gate is off.
    checks: { commands: [], format: null, lint: null, ...(checks as Record<string, unknown>) },
    ...rest,
  })

const makeRunner = (
  tracker: Tracker,
  harness: Harness,
  cfg = config(),
  forge = new FakePr(),
  runExec: Exec = exec,
  leaseHeartbeatMs?: number,
) =>
  new Runner({
    store,
    tracker,
    harness,
    config: cfg,
    repoRoot: repo,
    repoName: 'demo',
    forge,
    exec: runExec,
    ...(leaseHeartbeatMs === undefined ? {} : { leaseHeartbeatMs }),
  })

const types = (taskId: string): EventType[] =>
  store.events({ taskId, limit: 999 }).map((e) => e.type)

const states = (taskId: string): (string | null | undefined)[] =>
  store
    .events({ taskId, limit: 999 })
    .filter((e) => e.type === 'task.state')
    .map((e) => (e as Extract<StoredEvent, { type: 'task.state' }>).to)

const stateReason = (taskId: string): string =>
  store
    .events({ taskId, limit: 999 })
    .filter((e): e is Extract<StoredEvent, { type: 'task.state' }> => e.type === 'task.state')
    .at(-1)?.reason ?? ''

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

/** A harness whose agent never finishes until it is killed, for interrupt tests. */
const hungHarness = () => {
  const queue = new AsyncQueue<AgentEvent>()
  let killed = false
  let resolveDone: (o: AgentOutcome) => void = () => {}
  const done = new Promise<AgentOutcome>((resolve) => {
    resolveDone = resolve
  })
  const agent: AgentProcess = {
    pid: 42,
    events: () => queue,
    done,
    kill: async () => {
      killed = true
      queue.close()
      resolveDone({
        exitCode: 1,
        ok: false,
        sessionId: null,
        summary: null,
        usage: null,
        stderr: '',
      })
    },
    model: null,
    effort: null,
  }
  const harness: Harness = {
    kind: 'fake',
    start: () => {
      queue.push({ kind: 'text', text: 'working...' })
      return agent
    },
    resume: () => agent,
    listModels: async () => [],
    listEfforts: async () => [],
  }
  return { harness, isKilled: () => killed }
}

/** Starts a run, lets it reach the agent, then parks the task in cancelled. */
const cancelMidRun = async (): Promise<void> => {
  const pending = makeRunner(new FakeTracker([TASK]), hungHarness().harness).runOnce()
  await waitFor(() =>
    store.events({ taskId: TASK.id, limit: 999 }).some((e) => e.type === 'agent.started'),
  )
  store.append(TASK.id, {
    type: 'task.state',
    from: 'implementing',
    to: 'cancelled',
    reason: 'operator interrupt',
  })
  expect((await pending)?.state).toBe('cancelled')
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
      'run.limits',
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

  test('renders the agent-authored conclusion after the changed-files list', async () => {
    const tracker = new FakeTracker([TASK])
    tracker.freshTask = {
      ...TASK,
      description: 'Write hello.txt\n\n### Conclusion\n\nAdded hello.txt with a greeting.',
    }
    const pr = new FakePr()
    await makeRunner(tracker, new FakeHarness([writesAFile]), config(), pr).runOnce()

    const body = pr.calls[0]?.body ?? ''
    expect(body.indexOf('### 🛠️ What changed')).toBeLessThan(body.indexOf('### 🧠 Conclusion'))
    expect(body).toContain('### 🧠 Conclusion')
    expect(body).toContain('Added `hello.txt` with a greeting.')
  })

  test('falls back to the run summary when the agent wrote no conclusion', async () => {
    const pr = new FakePr()
    await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([
        { ...writesAFile, outcome: { summary: 'wrote hello.txt, fixed the greeting' } },
      ]),
      config(),
      pr,
    ).runOnce()

    const body = pr.calls[0]?.body ?? ''
    expect(body).toContain('### 🧠 Conclusion')
    expect(body).toContain('wrote `hello.txt`, fixed the greeting')
  })

  test('a task with no description still gets a summary section from the agent run summary', async () => {
    const pr = new FakePr()
    await makeRunner(
      new FakeTracker([{ ...TASK, description: '' }]),
      new FakeHarness([
        { ...writesAFile, outcome: { summary: 'Dedup by exact comment id, not by watermark' } },
      ]),
      config(),
      pr,
    ).runOnce()

    expect(pr.calls[0]?.body).toContain('### 📝 Summary')
    expect(pr.calls[0]?.body).toContain('Dedup by exact comment id, not by watermark')
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

  test('a committed task whose diff against base is empty goes to no_pr without a PR', async () => {
    const pr = new FakePr()
    const emptyDiff: Exec = async (cmd, opts) => {
      const result = await exec(cmd, opts)
      if (cmd.includes('--numstat')) return { ...result, stdout: '' }
      return result
    }
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
      config(),
      pr,
      emptyDiff,
    ).runOnce()

    expect(result?.state).toBe('no_pr')
    expect(types(TASK.id)).toContain('commit.created')
    expect(types(TASK.id)).not.toContain('pr.created')
    expect(pr.calls).toHaveLength(0)
    const stateEvent = store
      .events({ taskId: TASK.id, limit: 999 })
      .find((e) => e.type === 'task.state' && e.to === 'no_pr')
    expect(stateEvent?.type === 'task.state' && stateEvent.reason).toContain(
      'diff against main is empty',
    )
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

  test('the implement prompt embeds the re-fetched notes and comments', async () => {
    const tracker = new FakeTracker([TASK])
    tracker.freshTask = {
      ...TASK,
      notes: 'root cause: biome EPIPE panic when piped through head/tail',
      comments: ['land the prompt rule'],
    }
    const harness = new FakeHarness([writesAFile])
    await makeRunner(tracker, harness).runOnce()

    expect(harness.calls[0]?.prompt).toContain('Issue notes:')
    expect(harness.calls[0]?.prompt).toContain(
      'root cause: biome EPIPE panic when piped through head/tail',
    )
    expect(harness.calls[0]?.prompt).toContain('- land the prompt rule')
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

  test('a reclaimed lease stops the run without parking the task in needs_human', async () => {
    // The stall watcher (or bd reclaim) takes the claim back mid-run: the
    // tracker heartbeat goes dead and the runner must stop before colliding
    // with the new owner, leaving the task in the claimed state the reclaim
    // parked it in instead of escalating to needs_human.
    const tracker = new FakeTracker([TASK])
    tracker.leaseAlive = false
    const released: string[] = []
    tracker.release = async (id) => {
      released.push(id)
    }

    let resolveDone!: (o: AgentOutcome) => void
    const done = new Promise<AgentOutcome>((resolve) => {
      resolveDone = resolve
    })
    const queue = new AsyncQueue<AgentEvent>()
    const agent: AgentProcess = {
      pid: 9,
      events: () => queue,
      done,
      kill: async () => {},
      model: null,
      effort: null,
    }
    const harness: Harness = {
      kind: 'fake',
      start: () => {
        queue.push({ kind: 'text', text: 'working...' })
        // The stall watcher reclaims the claim while the agent is still running.
        setTimeout(() => store.append(TASK.id, { type: 'task.reclaimed' }), 100)
        setTimeout(() => {
          queue.close()
          resolveDone({
            exitCode: 0,
            ok: true,
            sessionId: 'sess-1',
            summary: 'done',
            usage: null,
            stderr: '',
          })
        }, 300)
        return agent
      },
      resume: () => agent,
      listModels: async () => [],
      listEfforts: async () => [],
    }

    const result = await makeRunner(tracker, harness, config(), new FakePr(), exec, 50).runOnce()

    expect(result?.state).toBe('claimed')
    expect(store.task(TASK.id)?.state).toBe('claimed')
    expect(store.task(TASK.id)?.lastError).toContain('claim lease was reclaimed')
    expect(types(TASK.id)).not.toContain('needs_human')
    // The claim was already reclaimed, so the runner must not release it again.
    expect(released).toEqual([])
  })

  test('a task deferred in retrying is picked up after its retry time, reusing the worktree', async () => {
    const wtPath = join(wtRoot, 'resume-worktree')
    const branch = 'amagi/bd-a1b2-add-a-greeting-file'
    await execOk(exec, ['git', 'worktree', 'add', '-b', branch, wtPath, 'main'], { cwd: repo })

    store.append(TASK.id, { type: 'task.claimed', title: TASK.title, tracker: 'fake' })
    store.append(TASK.id, { type: 'worktree.created', path: wtPath, branch })
    store.append(TASK.id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append(TASK.id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append(TASK.id, {
      type: 'retry.scheduled',
      attempt: 1,
      delayMs: 0,
      reason: 'transient harness failure',
      detail: 'hit the session limit',
    })
    store.append(TASK.id, { type: 'task.state', from: 'implementing', to: 'retrying' })

    const harness = new FakeHarness([writesAFile])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('pr_open')
    // Fresh harness turn in the recorded worktree; no second worktree is created.
    expect(harness.calls[0]?.cwd).toBe(wtPath)
    expect(harness.calls[0]?.resumeFrom).toBeNull()
    expect(harness.calls[0]?.prompt).toContain('resumed')
    expect(store.task(TASK.id)?.worktree).toBe(wtPath)
    expect(store.task(TASK.id)?.branch).toBe(branch)
    expect(
      store.events({ taskId: TASK.id }).filter((e) => e.type === 'worktree.created'),
    ).toHaveLength(2)
    const created = store
      .events({ taskId: TASK.id })
      .filter((e) => e.type === 'worktree.created')
      .map((e) => (e as Extract<StoredEvent, { type: 'worktree.created' }>).path)
    expect(new Set(created)).toEqual(new Set([wtPath]))
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

  test('the mandatory format+lint gate runs first and a failing lint is handed back to the agent', async () => {
    const harness = new FakeHarness([
      { effect: (cwd) => writeFileSync(join(cwd, 'flag'), 'bad\n') },
      { effect: (cwd) => writeFileSync(join(cwd, 'flag'), 'good\n') },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({
        checks: {
          commands: ['grep -q good flag'],
          format: 'touch formatted',
          lint: 'grep -q good flag',
        },
      }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    // format ran first, so its side effect is in the committed worktree
    const wt = store.task(TASK.id)?.worktree
    expect(wt !== undefined && wt !== null && existsSync(join(wt, 'formatted'))).toBe(true)
    // the failing lint was handed back to the same session to fix in place
    expect(harness.calls[1]?.resumeFrom).toBe('sess-1')
    expect(harness.calls[1]?.prompt).toContain('grep -q good flag')
    expect(harness.calls[1]?.prompt).toContain('checks failed')
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

  test('a failed agent with no stderr or summary mines the last assistant text as the reason', async () => {
    const harness = new FakeHarness([
      {
        events: [
          { kind: 'text', text: 'I cannot finish: the registry is unreachable' },
          { kind: 'tool_result', name: 'Bash', ok: true, output: 'ok' },
        ],
        outcome: { ok: false, exitCode: 1, summary: null, stderr: '' },
      },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('needs_human')
    const reason = stateReason(TASK.id)
    expect(reason).toContain('registry is unreachable')
    expect(reason).not.toContain('exit 1')
  })

  test('a failed agent prefers the harness result message over stream noise', async () => {
    const harness = new FakeHarness([
      {
        events: [
          { kind: 'text', text: 'working on it' },
          { kind: 'tool_result', name: 'Bash', ok: false, output: 'disk full' },
          { kind: 'result', ok: false, summary: 'registry unreachable' },
        ],
        outcome: { ok: false, exitCode: 1, summary: null, stderr: '' },
      },
    ])
    // "hit the turn limit" is a session-limit pattern, so without disabling
    // retries the run would back off instead of escalating to needs_human.
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { maxRetries: 0 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(stateReason(TASK.id)).toContain('registry unreachable')
  })

  test('a failed agent falls back to the failing tool output when there is no result or text', async () => {
    const harness = new FakeHarness([
      {
        events: [
          { kind: 'tool_result', name: 'Bash', ok: false, output: 'command not found: lint' },
        ],
        outcome: { ok: false, exitCode: 1, summary: null, stderr: '' },
      },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(stateReason(TASK.id)).toContain('command not found: lint')
  })

  test('a failed agent with nothing mined names the phase and points at the log', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 7, summary: null, stderr: '' } },
    ])
    const result = await makeRunner(new FakeTracker([TASK]), harness).runOnce()

    expect(result?.state).toBe('needs_human')
    const reason = stateReason(TASK.id)
    expect(reason).toContain('implement phase failed (exit 7)')
    expect(reason).toContain('task log')
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

  test('a session-limit failure defers, retries in a fresh session, and keeps one worktree', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'hit the session limit', sessionId: 'sess-1' } },
      writesAFile,
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { retryBaseMs: 0, retryMaxMs: 0 } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.calls).toHaveLength(2)
    // The spent session is not resumed; the retry starts a fresh harness turn.
    expect(harness.calls[1]?.resumeFrom).toBeNull()
    const scheduled = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'retry.scheduled' }> => e.type === 'retry.scheduled',
      )
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.detail).toBe('hit the session limit')
    expect(states(TASK.id)).toContain('retrying')
    // The retry keeps the original worktree; none is created a second time.
    const created = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'worktree.created' }> =>
          e.type === 'worktree.created',
      )
    expect(created).toHaveLength(1)
    expect(created[0]?.path ?? null).toEqual(store.task(TASK.id)?.worktree ?? null)
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

  test('a task that exceeds maxRunMinutes escalates to needs_human with the figures', async () => {
    store.append(TASK.id, { type: 'task.claimed', title: TASK.title, tracker: 'fake' })
    store.db
      .query('update tasks set created_at = ? where id = ?')
      .run(Date.now() - 61 * 60_000, TASK.id)

    const harness = new FakeHarness([writesAFile])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { maxRunMinutes: 60 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(0)
    const reason = stateReason(TASK.id)
    expect(reason).toContain('budget exhausted')
    expect(reason).toContain('max run time of 1h exceeded')
    expect(store.task(TASK.id)?.lastError).toContain('max run time of 1h exceeded')
  })

  test('a task that exceeds maxCostUsd escalates mid-run with the figures', async () => {
    const harness = new FakeHarness([
      {
        events: [
          { kind: 'usage', inputTokens: 100, outputTokens: 100, costUsd: 3 },
          { kind: 'usage', inputTokens: 100, outputTokens: 100, costUsd: 3 },
          { kind: 'text', text: 'wrote hello.txt' },
        ],
        effect: (cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'),
      },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { maxCostUsd: 5 } }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.calls).toHaveLength(1)
    const reason = stateReason(TASK.id)
    expect(reason).toContain('budget exhausted')
    expect(reason).toContain('max cost of $5.00 exceeded after $6.00')
  })

  test('a cost budget is skipped when the harness reports no cost', async () => {
    const harness = new FakeHarness([
      {
        events: [
          { kind: 'usage', inputTokens: 100, outputTokens: 100 },
          { kind: 'text', text: 'wrote hello.txt' },
        ],
        effect: (cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'),
      },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { maxCostUsd: 0.01 } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.calls).toHaveLength(1)
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

  test('runOnce with a task id drives that task instead of the next ready one', async () => {
    const tracker = new FakeTracker([{ ...TASK, id: 'bd-other' }, TASK])
    const harness = new FakeHarness([writesAFile])
    const result = await makeRunner(tracker, harness).runOnce(TASK.id)

    expect(result?.state).toBe('pr_open')
    expect(tracker.queue.some((t) => t.id === 'bd-other')).toBe(true)
    expect(harness.calls[0]?.cwd).toContain('bd-a1b2')
  })

  test('an interrupt kills the running agent and parks the task in cancelled', async () => {
    const { harness, isKilled } = hungHarness()

    const pending = makeRunner(new FakeTracker([TASK]), harness).runOnce()
    await waitFor(() =>
      store.events({ taskId: TASK.id, limit: 999 }).some((e) => e.type === 'agent.started'),
    )
    store.append(TASK.id, {
      type: 'task.state',
      from: 'implementing',
      to: 'cancelled',
      reason: 'operator interrupt',
    })

    const result = await pending
    expect(result?.state).toBe('cancelled')
    expect(isKilled()).toBe(true)
    expect(types(TASK.id)).not.toContain('commit.created')
    expect(types(TASK.id)).not.toContain('pr.created')
  })

  test('continue resumes a cancelled task in its recorded worktree', async () => {
    await cancelMidRun()
    const worktree = store.task(TASK.id)?.worktree
    expect(worktree).not.toBeNull()
    expect(existsSync(worktree as string)).toBe(true)

    const resumed = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
    ).runOnce(TASK.id)
    expect(resumed?.state).toBe('pr_open')
    expect(store.task(TASK.id)?.worktree).toBe(worktree)
    // The resumed run re-records the reused worktree, like every other run.
    expect(types(TASK.id).filter((t) => t === 'worktree.created')).toHaveLength(2)
  })

  test('continue falls back to a fresh worktree when the recorded one is gone', async () => {
    await cancelMidRun()
    const worktree = store.task(TASK.id)?.worktree
    expect(worktree).not.toBeNull()
    rmSync(worktree as string, { recursive: true, force: true })

    const resumed = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
    ).runOnce(TASK.id)
    expect(resumed?.state).toBe('pr_open')
    expect(store.task(TASK.id)?.worktree).toBe(worktree)
    expect(existsSync(worktree as string)).toBe(true)
    expect(types(TASK.id).filter((t) => t === 'worktree.created')).toHaveLength(2)
  })
})

describe('Runner context budget', () => {
  const usage = (inputTokens: number, cachedTokens = 0, outputTokens = 10): AgentEvent => ({
    kind: 'usage',
    inputTokens,
    outputTokens,
    cachedTokens,
  })

  test('crossing the soft limit warns but the run completes', async () => {
    const harness = new FakeHarness([
      {
        ...writesAFile,
        events: [{ kind: 'text', text: 'wrote hello.txt' }, usage(180_000, 10_000)],
      },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { contextWarnTokens: 150_000, contextMaxTokens: 300_000 } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    expect(harness.kills).toBe(0)
    const warns = store
      .events({ taskId: TASK.id })
      .filter((e): e is Extract<StoredEvent, { type: 'context.warn' }> => e.type === 'context.warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.contextTokens).toBe(190_000)
    expect(warns[0]?.limit).toBe(150_000)
    expect(types(TASK.id)).not.toContain('context.exceeded')
  })

  test('the warning fires once on the peak, not on every usage event', async () => {
    const harness = new FakeHarness([
      {
        ...writesAFile,
        events: [usage(80_000, 20_000), usage(100_000, 50_000), usage(120_000, 60_000)],
      },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { contextWarnTokens: 150_000, contextMaxTokens: 300_000 } }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    const warns = store
      .events({ taskId: TASK.id })
      .filter((e): e is Extract<StoredEvent, { type: 'context.warn' }> => e.type === 'context.warn')
    expect(warns).toHaveLength(1)
    const peaks = store
      .events({ taskId: TASK.id })
      .filter((e): e is Extract<StoredEvent, { type: 'run.context' }> => e.type === 'run.context')
      .map((e) => e.contextTokens)
    // Peak grows 100k -> 150k -> 180k; only new peaks are recorded.
    expect(peaks).toEqual([100_000, 150_000, 180_000])
  })

  test('crossing the hard limit kills the agent, restarts it fresh with a handoff, and continues', async () => {
    const harness = new FakeHarness([
      { ...writesAFile, events: [usage(190_000, 15_000)] },
      { effect: (cwd) => writeFileSync(join(cwd, 'second.txt'), 'hi\n') },
    ])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { contextWarnTokens: 150_000, contextMaxTokens: 200_000 } }),
    ).runOnce()

    // The restarted session finishes the task; the worktree and claim are reused.
    expect(result?.state).toBe('pr_open')
    expect(harness.kills).toBe(1)
    expect(harness.calls).toHaveLength(2)
    // The restart runs a fresh session (no resume) with the handoff as context.
    expect(harness.calls[1]?.resumeFrom).toBeNull()
    expect(harness.calls[1]?.prompt).toContain('context budget')
    expect(harness.calls[1]?.prompt).toContain('Files changed in the worktree')
    expect(harness.calls[1]?.prompt).toContain('hello.txt')
    expect(harness.calls[1]?.cwd).toBe(harness.calls[0]?.cwd)
    // One worktree for the whole run; the killed session's file survives.
    expect(
      store.events({ taskId: TASK.id }).filter((e) => e.type === 'worktree.created'),
    ).toHaveLength(1)
    expect(existsSync(join(harness.calls[0]?.cwd ?? '', 'hello.txt'))).toBe(true)
    const restarted = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'run.restarted' }> => e.type === 'run.restarted',
      )
    expect(restarted).toHaveLength(1)
    expect(restarted[0]?.restart).toBe(1)
    expect(restarted[0]?.contextTokens).toBe(205_000)
    expect(restarted[0]?.summary).toContain('hello.txt')
    const exceeded = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'context.exceeded' }> =>
          e.type === 'context.exceeded',
      )
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]?.contextTokens).toBe(205_000)
    expect(exceeded[0]?.limit).toBe(200_000)
    expect(types(TASK.id)).toContain('context.warn')
    expect(types(TASK.id)).not.toContain('needs_human')
    // A guard kill is a deliberate stop, not an agent failure: no error event.
    const errors = store.events({ taskId: TASK.id }).filter((e) => e.type === 'error')
    expect(errors.some((e) => e.type === 'error' && e.message.includes('agent failed'))).toBe(false)
  })

  test('the restart budget is spent across phases and escalates to needs_human when exhausted', async () => {
    const crossing = { ...writesAFile, events: [usage(190_000, 15_000)] }
    const harness = new FakeHarness([crossing, crossing])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({
        loop: { contextWarnTokens: 150_000, contextMaxTokens: 200_000, contextMaxRestarts: 1 },
      }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(store.task(TASK.id)?.state).toBe('needs_human')
    expect(harness.kills).toBe(2)
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.resumeFrom).toBeNull()
    const restarted = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'run.restarted' }> => e.type === 'run.restarted',
      )
    expect(restarted).toHaveLength(1)
    const reason = stateReason(TASK.id)
    expect(reason).toContain('context budget exceeded after 1 restart')
    expect(reason).toContain('limit 200000')
  })

  test('contextMaxRestarts 0 keeps the historical hard-kill to needs_human', async () => {
    const harness = new FakeHarness([{ ...writesAFile, events: [usage(190_000, 15_000)] }])
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({
        loop: { contextWarnTokens: 150_000, contextMaxTokens: 200_000, contextMaxRestarts: 0 },
      }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.kills).toBe(1)
    expect(harness.calls).toHaveLength(1)
    expect(types(TASK.id)).not.toContain('run.restarted')
  })

  test('per-harness overrides win over the loop defaults', async () => {
    const harness = new FakeHarness([{ ...writesAFile, events: [usage(180_000)] }], 'codex')
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({
        loop: {
          // Loop defaults are far above the emitted usage, so only the
          // codex override can trip the guard here.
          contextWarnTokens: 1_000_000,
          contextMaxTokens: 1_000_000,
          contextMaxRestarts: 0,
          contextOverrides: { codex: { warnTokens: 150_000, maxTokens: 170_000 } },
        },
      }),
    ).runOnce()

    expect(result?.state).toBe('needs_human')
    expect(harness.kills).toBe(1)
    const exceeded = store
      .events({ taskId: TASK.id })
      .filter(
        (e): e is Extract<StoredEvent, { type: 'context.exceeded' }> =>
          e.type === 'context.exceeded',
      )
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]?.limit).toBe(170_000)
  })

  test('claiming a task records the effective run limits up front', async () => {
    const harness = new FakeHarness([writesAFile], 'codex')
    const result = await makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({
        loop: {
          contextWarnTokens: 160_000,
          contextMaxTokens: 200_000,
          contextOverrides: { codex: { warnTokens: 120_000, maxTokens: 140_000 } },
          maxRunMinutes: 45,
          maxCostUsd: 3,
        },
      }),
    ).runOnce()

    expect(result?.state).toBe('pr_open')
    const limits = store
      .events({ taskId: TASK.id })
      .filter((e): e is Extract<StoredEvent, { type: 'run.limits' }> => e.type === 'run.limits')
    expect(limits).toHaveLength(1)
    // Per-harness overrides win over the loop defaults; budgets come from loop.
    expect(limits[0]).toMatchObject({
      contextWarnTokens: 120_000,
      contextMaxTokens: 140_000,
      maxRunMs: 45 * 60_000,
      maxCostUsd: 3,
    })
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

  test('retryNow wakes a deferred retry so the next attempt runs immediately', async () => {
    const harness = new FakeHarness([
      { outcome: { ok: false, exitCode: 1, stderr: 'rate limit exceeded' } },
      writesAFile,
    ])
    const runner = makeRunner(
      new FakeTracker([TASK]),
      harness,
      config({ loop: { retryBaseMs: 60_000, retryMaxMs: 60_000 } }),
    )
    const pending = runner.runOnce()

    // The task parks in retrying for a 60s backoff; retryNow skips the wait.
    await waitFor(() => store.events({ taskId: TASK.id }).some((e) => e.type === 'retry.scheduled'))
    expect(store.task(TASK.id)?.state).toBe('retrying')
    const started = Date.now()
    runner.retryNow()
    const result = await pending

    expect(result?.state).toBe('pr_open')
    expect(harness.calls).toHaveLength(2)
    // The run completed well inside the 60s backoff, so it cannot have slept it out.
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
