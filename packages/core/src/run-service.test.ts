import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncQueue } from './async-queue.ts'
import { Config } from './config.ts'
import type {
  CreatePrOptions,
  OpenPr,
  PrComment,
  PrDriver,
  PrState,
  PullRequest,
} from './drivers/pr.ts'
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
import type { AgentEvent } from './events.ts'
import { exec, execOk } from './exec.ts'
import { RunService, type RunServiceOptions } from './run-service.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

const TASK: TrackerTask = {
  id: 'bd-a1b2',
  title: 'Add a greeting file',
  description: 'Write hello.txt',
  status: 'open',
  priority: 1,
  type: 'task',
  url: null,
}

const TASK2: TrackerTask = { ...TASK, id: 'bd-c3d4', title: 'Add a second file' }

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: true, edit: true, dependencies: true }
  readonly released: string[] = []

  constructor(private queue: TrackerTask[] = []) {}

  async ready(): Promise<TrackerTask[]> {
    return this.queue
  }
  async claim(id?: string): Promise<TrackerTask | null> {
    if (id !== undefined) return this.queue.find((t) => t.id === id) ?? null
    // Like a real tracker's atomic claim, a no-id claim consumes the task.
    return this.queue.shift() ?? null
  }
  async get(): Promise<TrackerTask | null> {
    return null
  }
  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    return {
      id: 'bd-new',
      title: input.title,
      description: input.description,
      status: 'open',
      priority: input.priority,
      type: null,
      url: null,
    }
  }
  async updateTask(id: string, input: UpdateTrackerTask): Promise<TrackerTask> {
    return {
      id,
      title: input.title ?? 'updated',
      description: '',
      status: 'open',
      priority: null,
      type: null,
      url: null,
    }
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(): Promise<void> {}
  async setStatus(_id: string, _s: TrackerStatus): Promise<void> {}
  async release(id: string): Promise<void> {
    this.released.push(id)
  }
  async close(): Promise<void> {}
  async openGate(_id: string, _q: Question): Promise<GateRef> {
    return { id: 'gate', advisory: false }
  }
  async gateResolved(): Promise<boolean> {
    return true
  }
  async resolveGate(): Promise<void> {}
}

class FakeHarness implements Harness {
  readonly kind = 'fake'

  constructor(private readonly effect?: (cwd: string) => void) {}

  start(opts: AgentStartOptions): AgentProcess {
    this.effect?.(opts.cwd)
    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ kind: 'text', text: 'done' })
    queue.close()
    const outcome: AgentOutcome = {
      exitCode: 0,
      ok: true,
      sessionId: 'sess-1',
      summary: 'done',
      usage: null,
      stderr: '',
    }
    return {
      pid: -1,
      events: () => queue,
      done: Promise.resolve(outcome),
      kill: async () => {},
      model: null,
      effort: null,
    }
  }
  resume(): AgentProcess {
    throw new Error('no resume in run-service tests')
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }
}

class BlockingHarness implements Harness {
  readonly kind = 'fake'
  starts = 0

  start(opts: AgentStartOptions): AgentProcess {
    this.starts++
    let resolveDone!: (o: AgentOutcome) => void
    const done = new Promise<AgentOutcome>((resolve) => {
      resolveDone = resolve
    })
    const queue = new AsyncQueue<AgentEvent>()
    return {
      pid: 12345,
      events: () => queue,
      done,
      kill: async () => {
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
  }
  resume(): AgentProcess {
    throw new Error('no resume in run-service tests')
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }
}

/** Emits one stream event so the runner records agent.started, then stays alive. */
class ModelHarness implements Harness {
  readonly kind = 'fake'

  start(): AgentProcess {
    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ kind: 'text', text: 'working' })
    let resolveDone!: (o: AgentOutcome) => void
    const done = new Promise<AgentOutcome>((resolve) => {
      resolveDone = resolve
    })
    return {
      pid: 12346,
      events: () => queue,
      done,
      kill: async () => {
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
      model: 'fake-model',
      effort: 'high',
    }
  }
  resume(): AgentProcess {
    throw new Error('no resume in run-service tests')
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }
}

class FakePr implements PrDriver {
  async createPr(opts: CreatePrOptions): Promise<PullRequest> {
    return { url: `https://example.com/pull/${opts.branch}`, number: 1 }
  }
  async getPr(_cwd: string, _number: number): Promise<PrState> {
    return 'open'
  }
  async getMergeStatus(_cwd: string, _number: number) {
    return 'mergeable' as const
  }
  async listOpenPrs(_cwd: string): Promise<OpenPr[]> {
    return []
  }
  async listComments(_cwd: string, _number: number): Promise<PrComment[]> {
    return []
  }
  async postComment(_cwd: string, _number: number, _body: string): Promise<void> {}
  async closePr(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
}

let repo: string
let wtRoot: string
let store: Store

const config = (over: Record<string, unknown> = {}) =>
  Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: wtRoot },
    checks: { commands: [], format: null, lint: null },
    ...over,
  })

const makeService = (
  tracker: Tracker,
  harness: Harness,
  maxParallel = 1,
  cfg = config(),
  over: Partial<RunServiceOptions> = {},
) =>
  new RunService({
    store,
    tracker,
    harness,
    config: cfg,
    repoRoot: repo,
    repoName: 'demo',
    forge: new FakePr(),
    maxParallel,
    ...over,
  })

const waitFor = async (fn: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> => {
  const started = Date.now()
  while (!(await fn())) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  repo = mkdtempSync(join(tmpdir(), 'amagi-runservice-repo-'))
  wtRoot = mkdtempSync(join(tmpdir(), 'amagi-runservice-wt-'))
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

describe('RunService', () => {
  test('status reports availability and capacity', async () => {
    const service = makeService(new FakeTracker(), new FakeHarness(), 2)
    expect(await service.status()).toEqual({
      name: 'demo',
      available: true,
      capacity: 2,
      running: [],
      startedAt: {},
      resources: {},
      tasks: {},
      autoQueue: false,
    })
    service.dispose()
  })

  test('setAutoQueue flips the reported state and toggles dispatch', async () => {
    const tracker = new FakeTracker([TASK])
    const harness = new BlockingHarness()
    const service = makeService(tracker, harness, 1, config(), { autoQueueActiveMs: 10 })
    expect((await service.status()).autoQueue).toBe(false)
    service.setAutoQueue(true)
    expect((await service.status()).autoQueue).toBe(true)
    await waitFor(() => harness.starts > 0)
    expect(store.task(TASK.id)?.state).toBe('implementing')
    await service.stop(TASK.id)
    service.dispose()
  })

  test('auto queue fills every free slot and backs off when the queue is empty', async () => {
    const tracker = new FakeTracker([TASK, TASK2])
    const harness = new BlockingHarness()
    const service = makeService(tracker, harness, 2, config(), {
      autoQueue: true,
      autoQueueActiveMs: 10,
    })
    // Both slots fill over successive polls, one task per pass.
    await waitFor(() => harness.starts >= 2)
    expect(harness.starts).toBe(2)
    expect((await service.status()).running).toEqual([TASK.id, TASK2.id])
    await service.stop(TASK.id)
    await service.stop(TASK2.id)
    service.dispose()
  })

  test('auto queue does nothing when disabled and idles after an empty poll', async () => {
    const tracker = new FakeTracker([])
    const service = makeService(tracker, new FakeHarness(), 1, config(), {
      autoQueue: true,
      autoQueueIdleMs: 20,
      autoQueueActiveMs: 10,
    })
    // Nothing to claim, so the first poll backs off to the idle interval; a
    // second poll still finds nothing and never launches.
    await Bun.sleep(100)
    expect((await service.status()).running).toEqual([])
    service.dispose()
  })

  test('status carries each running task title and live agent', async () => {
    const service = makeService(new FakeTracker([TASK]), new BlockingHarness(), 1)
    const started = await service.start()
    expect(started.ok).toBe(true)
    await waitFor(() => store.task(TASK.id)?.state === 'implementing')

    const status = await service.status()
    expect(status.tasks[TASK.id]).toEqual({
      title: 'Add a greeting file',
      harness: 'fake',
      model: null,
      effort: null,
    })

    await service.stop(TASK.id)
  })

  test('status carries the model once the agent run reports it', async () => {
    const service = makeService(new FakeTracker([TASK]), new ModelHarness(), 1)
    const started = await service.start()
    expect(started.ok).toBe(true)
    await waitFor(() => store.task(TASK.id)?.state === 'implementing')

    const status = await service.status()
    expect(status.tasks[TASK.id]).toEqual({
      title: 'Add a greeting file',
      harness: 'fake',
      model: 'fake-model',
      effort: 'high',
    })

    await service.stop(TASK.id)
  })

  test('setMaxParallel changes capacity live without touching running runs', async () => {
    const service = makeService(new FakeTracker([TASK]), new BlockingHarness(), 1)
    const started = await service.start()
    expect(started.ok).toBe(true)
    await waitFor(() => store.task(TASK.id)?.state === 'implementing')
    service.setMaxParallel(4)
    const status = await service.status()
    expect(status.available).toBe(true)
    expect(status.capacity).toBe(4)
    expect(status.running).toEqual([TASK.id])
    // a buggy caller cannot zero the runner out
    service.setMaxParallel(0)
    expect((await service.status()).capacity).toBe(1)
    await service.stop(TASK.id)
  })

  test('setMaxParallel raises the ceiling for new launches', async () => {
    const service = makeService(new FakeTracker([TASK, TASK2]), new BlockingHarness(), 1)
    expect((await service.start(TASK.id)).ok).toBe(true)
    expect((await service.start(TASK2.id)).ok).toBe(false)
    service.setMaxParallel(2)
    expect(await service.start(TASK2.id)).toEqual({ ok: true, taskId: TASK2.id })
    await service.stop(TASK.id)
    await service.stop(TASK2.id)
  })

  test('start launches the next ready task and it completes', async () => {
    const service = makeService(
      new FakeTracker([TASK]),
      new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
    )
    const res = await service.start()
    expect(res).toEqual({ ok: true, taskId: TASK.id })

    await waitFor(() => store.task(TASK.id)?.state === 'pr_open')
    await waitFor(async () => (await service.status()).running.length === 0)
  })

  test('start launches a specific ready task', async () => {
    const service = makeService(
      new FakeTracker([TASK2, TASK]),
      new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
    )
    const res = await service.start(TASK.id)
    expect(res).toEqual({ ok: true, taskId: TASK.id })
    await waitFor(() => store.task(TASK.id)?.state === 'pr_open')
    expect(store.task(TASK2.id)).toBeNull()
  })

  test('start refuses a specific task the model tier cannot claim', async () => {
    const hard = { ...TASK, difficulty: 'high' }
    const service = makeService(
      new FakeTracker([hard]),
      new FakeHarness(),
      1,
      config({
        harness: { implement: { kind: 'claude', model: 'claude-haiku-4-5' } },
        difficulty: {
          enabled: true,
          modelTiers: { 'claude-haiku-4-5': 'fast', 'claude-sonnet-4-5': 'smart' },
          requiredTier: { high: 'smart' },
        },
      }),
    )
    const res = await service.start(TASK.id)
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: 'task bd-a1b2: claude-haiku-4-5 is only a fast model but high difficulty needs smart',
    })
  })

  test('start rejects an unknown harness name', async () => {
    const service = makeService(new FakeTracker([TASK]), new FakeHarness())
    const res = await service.start(undefined, { harness: 'nope' })
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: 'unknown harness "nope"; use a harness.definitions name or claude/codex/opencode',
    })
  })

  test('start resolves a bare kind to the implement harness so its bin carries over', async () => {
    let captured: Config['harness']['implement'] | null = null
    const cfg = config({
      harness: {
        implement: { kind: 'opencode', bin: 'opencode-unconfined', permissions: 'bypass' },
      },
    })
    const service = new RunService({
      store,
      tracker: new FakeTracker([TASK]),
      harness: new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
      config: cfg,
      repoRoot: repo,
      repoName: 'demo',
      forge: new FakePr(),
      makeHarness: (c) => {
        captured = c
        return new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'))
      },
    })
    const res = await service.start(undefined, { harness: 'opencode' })
    expect(res).toEqual({ ok: true, taskId: TASK.id })
    await waitFor(() => store.task(TASK.id)?.state === 'pr_open')
    expect(captured).toMatchObject({
      kind: 'opencode',
      bin: 'opencode-unconfined',
      permissions: 'bypass',
    })
  })

  test('start applies harness/model/effort overrides to the launched run', async () => {
    let captured: Config['harness']['implement'] | null = null
    const service = new RunService({
      store,
      tracker: new FakeTracker([TASK]),
      harness: new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
      config: config(),
      repoRoot: repo,
      repoName: 'demo',
      forge: new FakePr(),
      makeHarness: (cfg) => {
        captured = cfg
        return new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'))
      },
    })
    const res = await service.start(undefined, {
      harness: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'high',
    })
    expect(res).toEqual({ ok: true, taskId: TASK.id })
    await waitFor(() => store.task(TASK.id)?.state === 'pr_open')
    expect(captured).toEqual(
      expect.objectContaining({ kind: 'codex', model: 'gpt-5.6-luna', effort: 'high' }),
    )
  })

  test('start resolves a named harness definition for the harness override', async () => {
    let captured: Config['harness']['implement'] | null = null
    const service = new RunService({
      store,
      tracker: new FakeTracker([TASK]),
      harness: new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
      config: config({
        harness: {
          definitions: { fast: { kind: 'claude', model: 'claude-haiku-4-5', effort: 'low' } },
        },
      }),
      repoRoot: repo,
      repoName: 'demo',
      forge: new FakePr(),
      makeHarness: (cfg) => {
        captured = cfg
        return new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'))
      },
    })
    const res = await service.start(undefined, { harness: 'fast' })
    expect(res).toEqual({ ok: true, taskId: TASK.id })
    await waitFor(() => store.task(TASK.id)?.state === 'pr_open')
    expect(captured).toEqual(
      expect.objectContaining({ kind: 'claude', model: 'claude-haiku-4-5', effort: 'low' }),
    )
  })

  test('start gates a claimed task on the override model, not the configured default', async () => {
    const hard = { ...TASK, difficulty: 'high' }
    let captured: Config['harness']['implement'] | null = null
    const service = new RunService({
      store,
      tracker: new FakeTracker([hard]),
      harness: new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n')),
      config: config({
        harness: { implement: { kind: 'claude', model: 'claude-sonnet-5' } },
        difficulty: {
          enabled: true,
          modelTiers: { 'claude-haiku-4-5': 'fast', 'claude-sonnet-5': 'smart' },
          requiredTier: { high: 'smart' },
        },
      }),
      repoRoot: repo,
      repoName: 'demo',
      forge: new FakePr(),
      makeHarness: (cfg) => {
        captured = cfg
        return new FakeHarness((cwd) => writeFileSync(join(cwd, 'hello.txt'), 'hi\n'))
      },
    })
    const weak = await service.start(hard.id, { model: 'claude-haiku-4-5' })
    expect(weak).toEqual({
      ok: false,
      status: 409,
      error: 'task bd-a1b2: claude-haiku-4-5 is only a fast model but high difficulty needs smart',
    })
    expect(captured).toBeNull()
    const ok = await service.start(hard.id, { model: 'claude-sonnet-5' })
    expect(ok).toEqual({ ok: true, taskId: hard.id })
    await waitFor(() => store.task(hard.id)?.state === 'pr_open')
    expect(captured).toEqual(expect.objectContaining({ model: 'claude-sonnet-5' }))
  })

  test('start refuses a task the tracker does not see as ready', async () => {
    const service = makeService(new FakeTracker([]), new FakeHarness())
    const res = await service.start('bd-x')
    expect(res).toEqual({ ok: false, status: 409, error: 'task bd-x is not ready to run' })
  })

  test('start refuses to exceed capacity', async () => {
    const service = makeService(new FakeTracker([TASK, TASK2]), new BlockingHarness(), 1)
    const first = await service.start()
    expect(first.ok).toBe(true)
    const second = await service.start()
    expect(second).toEqual({ ok: false, status: 409, error: 'runner at capacity (1/1)' })
    await service.stop(TASK.id)
  })

  test('start refuses to launch the same task twice', async () => {
    const service = makeService(new FakeTracker([TASK]), new BlockingHarness(), 2)
    const first = await service.start(TASK.id)
    expect(first.ok).toBe(true)
    const again = await service.start(TASK.id)
    expect(again).toEqual({ ok: false, status: 409, error: `task ${TASK.id} is already running` })
    await service.stop(TASK.id)
  })

  test('concurrent launches of the same task cannot double-claim', async () => {
    const service = makeService(new FakeTracker([TASK]), new BlockingHarness(), 2)
    const [a, b] = await Promise.all([service.start(TASK.id), service.start(TASK.id)])
    const launched = [a, b].filter((r): r is { ok: true; taskId: string } => r.ok)
    expect(launched).toHaveLength(1)
    if (launched[0]) await service.stop(launched[0].taskId)
  })

  test('stop of a task not running here is a 404', async () => {
    const service = makeService(new FakeTracker([TASK]), new FakeHarness())
    const res = await service.stop('bd-x')
    expect(res).toEqual({ ok: false, status: 404, error: 'task bd-x is not running here' })
  })

  test('stop kills the run, releases the lease, and preserves the worktree', async () => {
    const tracker = new FakeTracker([TASK])
    const service = makeService(tracker, new BlockingHarness())
    const started = await service.start()
    expect(started.ok).toBe(true)

    await waitFor(() => store.task(TASK.id)?.state === 'implementing')
    const stopped = await service.stop(TASK.id)
    expect(stopped).toEqual({ ok: true, taskId: TASK.id })

    expect(store.task(TASK.id)?.state).toBe('cancelled')
    expect(tracker.released).toEqual([TASK.id])
    expect(store.task(TASK.id)?.worktree).not.toBeNull()
    expect(store.task(TASK.id)?.branch).not.toBeNull()
    await waitFor(async () => (await service.status()).running.length === 0)
  })
})
