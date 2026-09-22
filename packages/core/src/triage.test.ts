import { describe, expect, test } from 'bun:test'
import { AsyncQueue } from './async-queue.ts'
import { Config } from './config.ts'
import type { BeadsIssue } from './drivers/tracker/beads.ts'
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
} from './drivers/types.ts'
import type { AgentEvent } from './events.ts'
import type { RunOnceResult } from './runner.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'
import {
  actionFromAnswer,
  parseTriageDecision,
  Triage,
  type TriageDeps,
  type TriageImplementer,
} from './triage.ts'

const config = () => Config.parse({})

function issue(partial: Partial<BeadsIssue>): BeadsIssue {
  return {
    id: 'bd-x',
    title: 'Some task',
    description: '',
    status: 'open',
    priority: 1,
    type: 'task',
    url: null,
    acceptanceCriteria: null,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    childCount: 0,
    ...partial,
  }
}

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: true, edit: true, dependencies: true }
  readonly issues = new Map<string, BeadsIssue>()
  readonly childrenMap = new Map<string, BeadsIssue[]>()
  readonly getIssueOverrides = new Map<string, TrackerStatus>()
  readonly closed: string[] = []
  readonly comments: { id: string; body: string }[] = []
  readonly created: CreateTrackerTask[] = []
  readonly gates: GateRef[] = []

  async list(): Promise<BeadsIssue[]> {
    return [...this.issues.values()]
  }
  async children(id: string): Promise<BeadsIssue[]> {
    return this.childrenMap.get(id) ?? []
  }
  async getIssue(id: string): Promise<BeadsIssue | null> {
    const base = this.issues.get(id)
    if (base === undefined) return null
    const status = this.getIssueOverrides.get(id)
    return status === undefined ? base : { ...base, status }
  }
  async ready(): Promise<TrackerTask[]> {
    return [...this.issues.values()]
  }
  async claim(id?: string): Promise<TrackerTask | null> {
    if (id === undefined) return null
    const current = this.issues.get(id)
    if (current === undefined) return null
    this.issues.set(id, { ...current, status: 'in_progress' })
    return current
  }
  async get(id: string): Promise<TrackerTask | null> {
    return this.issues.get(id) ?? null
  }
  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    this.created.push(input)
    const created: BeadsIssue = {
      id: `bd-created-${this.created.length}`,
      title: input.title,
      description: input.description,
      status: 'open',
      priority: input.priority,
      type: 'task',
      url: null,
      acceptanceCriteria: input.acceptanceCriteria,
      assignee: null,
      labels: input.labels,
      parent: input.parent,
      dependencies: [],
      childCount: 0,
    }
    this.issues.set(created.id, created)
    return created
  }
  async updateTask(): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(id: string, body: string): Promise<void> {
    this.comments.push({ id, body })
  }
  async setStatus(): Promise<void> {}
  async release(): Promise<void> {}
  async close(id: string): Promise<void> {
    this.closed.push(id)
    const current = this.issues.get(id)
    if (current !== undefined) this.issues.set(id, { ...current, status: 'closed' })
  }
  async openGate(_id: string, q: Question): Promise<GateRef> {
    const ref: GateRef = { id: `gate-${q.id}`, advisory: false }
    this.gates.push(ref)
    return ref
  }
  async gateResolved(): Promise<boolean> {
    return true
  }
  async resolveGate(): Promise<void> {}
}

class StubHarness implements Harness {
  readonly kind = 'fake'
  constructor(private readonly reply: string) {}

  start(opts: AgentStartOptions): AgentProcess {
    return this.run(opts)
  }
  resume(_sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.run(opts)
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }
  private run(_opts: AgentStartOptions): AgentProcess {
    const queue = new AsyncQueue<AgentEvent>()
    queue.push({ kind: 'text', text: this.reply })
    queue.close()
    const outcome: AgentOutcome = {
      exitCode: 0,
      ok: true,
      sessionId: 'sess',
      summary: this.reply,
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
}

function makeTriage(
  tracker: Tracker,
  harness: Harness,
  store: Store,
  opts: { makeRunner?: (deps: unknown) => TriageImplementer } = {},
): Triage {
  const cfg = config()
  const deps: TriageDeps = {
    store,
    tracker,
    harness,
    config: cfg,
    repoRoot: '/repo',
    repoName: 'repo',
    ...(opts.makeRunner === undefined ? {} : { makeRunner: opts.makeRunner }),
  }
  return new Triage(deps)
}

describe('parseTriageDecision', () => {
  test('parses a bare JSON object', () => {
    const decision = parseTriageDecision('{"action":"close","reason":"children are all done"}')
    expect(decision?.action).toBe('close')
    expect(decision?.reason).toBe('children are all done')
  })

  test('parses JSON wrapped in code fences with prose around it', () => {
    const decision = parseTriageDecision(
      'Here you go:\n```json\n{"action":"decompose","reason":"container","subtasks":[{"title":"One","priority":2}]}\n```\nDone.',
    )
    expect(decision?.action).toBe('decompose')
    expect(decision?.subtasks[0]?.title).toBe('One')
    expect(decision?.subtasks[0]?.priority).toBe(2)
  })

  test('returns null on garbage', () => {
    expect(parseTriageDecision('I have no idea')).toBeNull()
    expect(parseTriageDecision('')).toBeNull()
    expect(parseTriageDecision('{"action":"nope"}')).toBeNull()
  })
})

describe('actionFromAnswer', () => {
  test('maps a free-form answer onto an action', () => {
    expect(actionFromAnswer('go ahead and implement it', 'skip')).toBe('implement')
    expect(actionFromAnswer('close it please', 'skip')).toBe('close')
    expect(actionFromAnswer('decompose into subtasks', 'skip')).toBe('decompose')
    expect(actionFromAnswer('skip for now', 'skip')).toBe('skip')
  })

  test('falls back when nothing matches', () => {
    expect(actionFromAnswer('investigate more', 'skip')).toBe('skip')
  })
})

describe('Triage', () => {
  test('nothing unclaimed returns null', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('a', issue({ id: 'a', status: 'closed' }))
    const triage = makeTriage(tracker, new StubHarness('{}'), store)
    expect(await triage.triageOnce()).toBeNull()
  })

  test('an unclaimed ready task with an implement decision is claimed and handed off', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', status: 'open', type: 'task' }))
    const ran: string[] = []
    const implementer: TriageImplementer = {
      async runClaimed(task: TrackerTask): Promise<RunOnceResult> {
        ran.push(task.id)
        return null
      },
    }
    const triage = makeTriage(
      tracker,
      new StubHarness('{"action":"implement","reason":"ready to go"}'),
      store,
      { makeRunner: () => implementer },
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('implement')
    expect(ran).toEqual(['t1'])
    // The claim was taken: the tracker now sees it as in_progress.
    expect(tracker.issues.get('t1')?.status).toBe('in_progress')
  })

  test('an implement decision refuses to steal a task that is no longer unclaimed', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', status: 'open', type: 'task' }))
    // list() still reports open, but by claim time a worker holds the task.
    tracker.getIssueOverrides.set('t1', 'in_progress')
    const ran: string[] = []
    const triage = makeTriage(
      tracker,
      new StubHarness('{"action":"implement","reason":"ready to go"}'),
      store,
      {
        makeRunner: () => ({
          async runClaimed(task: TrackerTask): Promise<RunOnceResult> {
            ran.push(task.id)
            return null
          },
        }),
      },
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('implement')
    expect(ran).toEqual([])
  })

  test('an epic with a decompose decision gets concrete subtasks under it', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('e1', issue({ id: 'e1', type: 'epic', status: 'open', childCount: 0 }))
    const triage = makeTriage(
      tracker,
      new StubHarness(
        JSON.stringify({
          action: 'decompose',
          reason: 'epic with no children',
          subtasks: [
            { title: 'Sub one', description: 'do a', priority: 1 },
            { title: 'Sub two', description: 'do b', priority: 2 },
          ],
        }),
      ),
      store,
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('decompose')
    expect(tracker.created).toHaveLength(2)
    expect(tracker.created[0]?.parent).toBe('e1')
    expect(tracker.created[1]?.title).toBe('Sub two')
  })

  test('a task with all children done is closed', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('e1', issue({ id: 'e1', type: 'epic', status: 'open', childCount: 2 }))
    tracker.childrenMap.set('e1', [
      issue({ id: 'c1', status: 'closed', parent: 'e1' }),
      issue({ id: 'c2', status: 'closed', parent: 'e1' }),
    ])
    const triage = makeTriage(
      tracker,
      new StubHarness('{"action":"close","reason":"all children done"}'),
      store,
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('close')
    expect(tracker.closed).toEqual(['e1'])
  })

  test('a skip decision records the reason as a comment', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', type: 'task', status: 'open' }))
    const triage = makeTriage(
      tracker,
      new StubHarness('{"action":"skip","reason":"human work"}'),
      store,
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('skip')
    expect(tracker.comments[0]?.body).toContain('human work')
  })

  test('an ask decision posts a question and is parked until the operator answers', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', type: 'task', status: 'blocked' }))
    const triage = makeTriage(
      tracker,
      new StubHarness(
        '{"action":"ask","reason":"ambiguous","question":"implement or close?","options":["implement","close"]}',
      ),
      store,
    )
    const result = await triage.triageOnce()
    expect(result?.action).toBe('ask')
    expect(tracker.gates).toHaveLength(1)
    expect(store.openQuestions('t1')).toHaveLength(1)

    // A second pass before answering leaves it parked.
    expect(await triage.triageOnce()).toBeNull()
  })

  test('an answered ask is acted on by the next pass', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', type: 'task', status: 'blocked' }))
    const triage = makeTriage(
      tracker,
      new StubHarness(
        '{"action":"ask","reason":"ambiguous","question":"implement or close?","options":["implement","close"]}',
      ),
      store,
    )
    await triage.triageOnce()
    const question = store.openQuestions('t1')[0]
    if (question === undefined) throw new Error('expected an open question')
    store.append('t1', {
      type: 'question.answered',
      questionId: question.id,
      answer: 'close it',
      via: 'web',
    })

    const second = await triage.triageOnce()
    expect(second?.action).toBe('close')
    expect(tracker.closed).toEqual(['t1'])
  })

  test('a harness failure degrades to a recorded skip, never a destructive guess', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('t1', issue({ id: 't1', type: 'task', status: 'open' }))
    const triage = makeTriage(tracker, new StubHarness('garbage reply'), store)
    const result = await triage.triageOnce()
    expect(result?.action).toBe('skip')
    expect(tracker.closed).toEqual([])
    expect(tracker.created).toEqual([])
  })

  test('in_progress, closed, and running tasks are never picked', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('wip', issue({ id: 'wip', status: 'in_progress', priority: 0 }))
    tracker.issues.set('done', issue({ id: 'done', status: 'closed', priority: 0 }))
    tracker.issues.set('running', issue({ id: 'running', status: 'open', priority: 0 }))
    store.append('running', { type: 'task.claimed', title: 'x', tracker: 'fake' })
    const triage = makeTriage(tracker, new StubHarness('{}'), store)
    expect(await triage.triageOnce()).toBeNull()
  })

  test('a decomposed container is re-triaged once all children close, then closed', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('e1', issue({ id: 'e1', type: 'epic', status: 'open', childCount: 1 }))
    tracker.childrenMap.set('e1', [issue({ id: 'c1', status: 'open', parent: 'e1' })])
    const triage = makeTriage(
      tracker,
      new StubHarness('{"action":"decompose","reason":"epic","subtasks":[{"title":"Sub"}]}'),
      store,
    )
    await triage.triageOnce()
    expect(tracker.created).toHaveLength(1)

    // Children all close; the epic is a candidate again and gets closed.
    const child = tracker.childrenMap.get('e1')?.[0]
    if (child === undefined) throw new Error('expected a child')
    tracker.childrenMap.set('e1', [{ ...child, status: 'closed' }])
    tracker.issues.set('c1', { ...child, status: 'closed' })
    tracker.getIssueOverrides.set('c1', 'closed')
    const second = new Triage({
      store,
      tracker,
      harness: new StubHarness('{"action":"close","reason":"all children done"}'),
      config: config(),
      repoRoot: '/repo',
      repoName: 'repo',
    })
    const result = await second.triageOnce()
    expect(result?.action).toBe('close')
    expect(tracker.closed).toEqual(['e1'])
  })

  test('a handled leaf is not re-triaged, but a container with open children can be', async () => {
    const store = new Store(openDatabase(':memory:'))
    const tracker = new FakeTracker()
    tracker.issues.set('leaf', issue({ id: 'leaf', status: 'open', priority: 0 }))
    tracker.issues.set('epic', issue({ id: 'epic', type: 'epic', status: 'open', childCount: 1 }))
    tracker.childrenMap.set('epic', [issue({ id: 'c1', status: 'open', parent: 'epic' })])
    const harness = new StubHarness('{"action":"skip","reason":"already handled"}')
    const triage = makeTriage(tracker, harness, store)

    await triage.triageOnce()
    expect(tracker.comments.some((c) => c.id === 'leaf')).toBe(true)

    // The leaf was handled; the epic is next (highest priority now).
    const second = await triage.triageOnce()
    expect(second?.task.id).toBe('epic')
  })
})
