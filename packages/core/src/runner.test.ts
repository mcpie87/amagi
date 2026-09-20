import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from './async-queue.ts'
import { Config } from './config.ts'
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
import type { AgentEvent, EventType } from './events.ts'
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
    }
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

const makeRunner = (tracker: Tracker, harness: Harness, cfg = config()) =>
  new Runner({ store, tracker, harness, config: cfg, repoRoot: repo, repoName: 'demo' })

const types = (taskId: string): EventType[] =>
  store.events({ taskId, limit: 999 }).map((e) => e.type)

beforeEach(async () => {
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

describe('Runner.runOnce', () => {
  test('an empty queue is not an error', async () => {
    expect(await makeRunner(new FakeTracker([]), new FakeHarness([])).runOnce()).toBeNull()
  })

  test('drives claim to commit and records the whole story', async () => {
    const result = await makeRunner(
      new FakeTracker([TASK]),
      new FakeHarness([writesAFile]),
    ).runOnce()

    expect(result?.state).toBe('committed')
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
    ])
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

    expect(result?.state).toBe('committed')
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
})
