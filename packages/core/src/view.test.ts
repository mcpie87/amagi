import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from './events.ts'
import {
  activeTasks,
  chatInFlight,
  chatTurns,
  currentAgentFor,
  currentUsageFor,
  initialDashboardState,
  openQuestionsFor,
  reduceBatch,
  reduceState,
  runHealth,
  runHealthNearLimit,
  stateAtAttempt,
  statusLog,
  taskEvents,
  tasksNeedingAttention,
} from './view.ts'

function ev(seq: number, taskId: string | null, ts: number, body: object): StoredEvent {
  return { seq, ts, taskId, ...body } as StoredEvent
}

const recorded: StoredEvent[] = [
  ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix the thing', tracker: 'bd' }),
  ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
  ev(3, 'am-1', 1200, {
    type: 'worktree.created',
    path: '/tmp/amagi/am-1',
    branch: 'fix-the-thing',
  }),
  ev(4, 'am-1', 1300, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
  ev(5, 'am-1', 1400, {
    type: 'checks.finished',
    ok: false,
    results: [{ command: 'bun run check', exitCode: 1, output: 'type error' }],
  }),
  ev(6, 'am-1', 1500, { type: 'task.state', from: 'implementing', to: 'checks' }),
  ev(7, 'am-1', 1600, {
    type: 'commit.created',
    sha: 'abc123',
    subject: 'fix(thing): do the thing',
  }),
  ev(8, 'am-1', 1700, { type: 'task.state', from: 'checks', to: 'committed' }),
  ev(9, 'am-1', 1800, {
    type: 'pr.created',
    url: 'https://github.com/x/amagi/pull/1',
    number: 1,
  }),
  ev(10, 'am-1', 1900, { type: 'task.state', from: 'committed', to: 'pr_open' }),
  ev(11, 'am-1', 2000, { type: 'task.state', from: 'pr_open', to: 'done' }),
  ev(12, 'am-2', 2200, { type: 'task.claimed', title: 'Second task', tracker: 'bd' }),
  ev(13, 'am-2', 2300, {
    type: 'question.asked',
    questionId: 'q-1',
    question: 'Which port?',
    options: ['8080', '4321'],
    gateRef: null,
  }),
  ev(14, 'am-2', 2400, {
    type: 'question.answered',
    questionId: 'q-1',
    answer: '4321',
    via: 'web',
  }),
]

describe('dashboard state reducer', () => {
  test('replay reconstructs the same state every time', () => {
    const a = recorded.reduce(reduceState, initialDashboardState())
    const b = recorded.reduce(reduceState, initialDashboardState())
    expect(b).toEqual(a)
    expect(b.latestSeq).toBe(14)
  })

  test('a batched fold matches folding one event at a time', () => {
    const single = recorded.reduce(reduceState, initialDashboardState())
    const batched = reduceBatch(
      reduceBatch(initialDashboardState(), recorded.slice(0, 5)),
      recorded.slice(5),
    )
    expect(batched).toEqual(single)
    expect(taskEvents(batched, 'am-2').map((e) => e.seq)).toEqual([12, 13, 14])
    expect(taskEvents(batched, 'am-9')).toEqual([])
  })

  test('a batch leaves the previous state untouched', () => {
    const before = reduceBatch(initialDashboardState(), recorded.slice(0, 3))
    const snapshot = structuredClone(before)
    reduceBatch(before, recorded.slice(3))
    expect(before).toEqual(snapshot)
  })

  test('folding projects tasks, worktree, branch, PR and checks', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    const done = state.tasks['am-1']
    expect(done?.title).toBe('Fix the thing')
    expect(done?.state).toBe('done')
    expect(done?.worktree).toBe('/tmp/amagi/am-1')
    expect(done?.branch).toBe('fix-the-thing')
    expect(done?.prUrl).toBe('https://github.com/x/amagi/pull/1')
    expect(done?.prNumber).toBe(1)
    expect(done?.checks).toEqual([{ command: 'bun run check', exitCode: 1, output: 'type error' }])
    expect(done?.checksOk).toBe(false)
    expect(done?.lastCommit?.sha).toBe('abc123')
    expect(done?.createdAt).toBe(1000)
    expect(done?.updatedAt).toBe(2000)
  })

  test('the shared reducer rejects illegal transitions like the server does', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    expect(() =>
      reduceState(
        state,
        ev(16, 'am-2', 2500, { type: 'task.state', from: 'claimed', to: 'pr_open' }),
      ),
    ).toThrow(/illegal transition/)
  })

  test('a pr.status event records the open PR merge status', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'pr.created', url: 'https://g/x/pull/1', number: 1 }),
      ...([...['worktree_ready', 'implementing', 'checks', 'committed', 'pr_open']] as const).map(
        (to, i) => ev(3 + i, 'am-1', 1200 + i, { type: 'task.state', from: null, to }),
      ),
      ev(8, 'am-1', 1900, { type: 'pr.status', mergeStatus: 'conflicted' }),
    ].reduce(reduceState, initialDashboardState())
    expect(state.tasks['am-1']?.prMergeStatus).toBe('conflicted')
    expect(state.tasks['am-1']?.updatedAt).toBe(1900)
  })

  test('reclaim returns a stuck task to the queue while keeping its worktree', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1200, { type: 'worktree.created', path: '/tmp/am-1', branch: 'x' }),
      ev(4, 'am-1', 1300, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(5, 'am-1', 1400, { type: 'task.reclaimed' }),
    ].reduce(reduceState, initialDashboardState())
    expect(state.tasks['am-1']?.state).toBe('queued')
    expect(state.tasks['am-1']?.worktree).toBe('/tmp/am-1')
    expect(state.tasks['am-1']?.branch).toBe('x')
    expect(activeTasks(state).map((t) => t.id)).toEqual([])
  })

  test('reset starts a fresh attempt and keeps the earlier one browsable', () => {
    const events = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1200, { type: 'worktree.created', path: '/tmp/am-1', branch: 'x' }),
      ev(4, 'am-1', 1300, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(5, 'am-1', 1350, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 2 },
      }),
      ev(6, 'am-1', 1360, {
        type: 'question.asked',
        questionId: 'q1',
        question: 'which?',
        options: [],
        gateRef: null,
      }),
      ev(7, 'am-1', 1400, { type: 'task.state', from: 'implementing', to: 'cancelled' }),
      ev(8, 'am-1', 1500, { type: 'worktree.removed', path: '/tmp/am-1' }),
      ev(9, 'am-1', 1600, { type: 'task.reset', reason: 'operator reset' }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(state.tasks['am-1']).toMatchObject({
      state: 'claimed',
      attempt: 2,
      worktree: null,
      createdAt: 1600,
    })
    expect(openQuestionsFor(state, 'am-1')).toEqual([])
    expect(runHealth(state, 'am-1', 1700)).toMatchObject({ costSeen: false, elapsedMs: 100 })

    const first = stateAtAttempt(state, 'am-1', 1)
    expect(first.tasks['am-1']).toMatchObject({ state: 'cancelled', attempt: 1 })
    expect(runHealth(first, 'am-1', 1700)).toMatchObject({ costUsd: 2, costSeen: true })
  })

  test('queue view lists only in-flight tasks, most recent first', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    const queue = activeTasks(state)
    expect(queue.map((t) => t.id)).toEqual(['am-2'])
    expect(queue[0]?.state).toBe('claimed')
  })

  test('attention list includes only tasks stopped for a human', () => {
    const state = [
      ...recorded.filter((e) => e.seq !== 11),
      ev(16, 'am-1', 2500, { type: 'task.state', from: 'pr_open', to: 'needs_human' }),
      ev(17, 'am-3', 2600, { type: 'task.claimed', title: 'Still running', tracker: 'bd' }),
    ].reduce(reduceState, initialDashboardState())

    expect(tasksNeedingAttention(state).map((t) => t.id)).toEqual(['am-1'])
  })

  test('a flagged pointless PR is surfaced in the attention list', () => {
    const state = [
      ...recorded.filter((e) => e.seq !== 11),
      ev(16, 'am-1', 2500, {
        type: 'task.state',
        from: 'pr_open',
        to: 'pr_flagged',
        reason: 'empty diff',
      }),
    ].reduce(reduceState, initialDashboardState())

    expect(tasksNeedingAttention(state).map((t) => t.id)).toEqual(['am-1'])
  })

  test('questions resolve from events', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    expect(openQuestionsFor(state, 'am-2')).toEqual([])
    const before = recorded.filter((e) => e.seq !== 14).reduce(reduceState, initialDashboardState())
    expect(openQuestionsFor(before, 'am-2').map((q) => q.id)).toEqual(['q-1'])
    expect(before.questions['q-1']?.answer).toBeNull()
  })

  test('current agent uses the latest start for the requested task', () => {
    const starts = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'old-model',
        effort: 'low',
        cwd: '/tmp/am-1',
        resumed: false,
      }),
      ev(2, 'am-2', 1100, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'other-model',
        effort: 'high',
        cwd: '/tmp/am-2',
        resumed: false,
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'current-model',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
    ]
    const state = starts.reduce(reduceState, initialDashboardState())
    expect(currentAgentFor(state, 'am-1')).toMatchObject({ model: 'current-model', effort: null })
    expect(currentAgentFor(state, 'missing')).toBeNull()
  })

  test('current agent ignores chat runs so the implementing agent stays named', () => {
    const events = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'impl',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: false,
      }),
      ev(2, 'am-1', 2000, {
        type: 'agent.started',
        role: 'chat',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(currentAgentFor(state, 'am-1')).toMatchObject({ model: 'impl', role: 'implement' })
  })

  test('current usage sums the tokens of the running agent run', () => {
    const events = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'm',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: false,
      }),
      ev(2, 'am-1', 1100, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 100, outputTokens: 50, cachedTokens: 20 },
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 20, outputTokens: 10, cachedTokens: 40 },
      }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(currentUsageFor(state, 'am-1')).toEqual({
      inputTokens: 120,
      outputTokens: 60,
      cachedTokens: 60,
    })
  })

  test('current usage ignores usage from earlier runs and chat runs', () => {
    const events = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'm',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: false,
      }),
      ev(2, 'am-1', 1100, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 999, outputTokens: 999 },
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: 0,
        sessionId: 's-1',
      }),
      ev(4, 'am-1', 1300, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'm2',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
      ev(5, 'am-1', 1400, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      }),
      ev(6, 'am-1', 1500, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'usage', inputTokens: 777, outputTokens: 777 },
      }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(currentUsageFor(state, 'am-1')).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
    })
    expect(currentUsageFor(state, 'missing')).toBeNull()
  })

  test('current usage is null before the harness reports anything', () => {
    const state = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'm',
        effort: null,
        cwd: '/tmp/am-1',
        resumed: false,
      }),
    ].reduce(reduceState, initialDashboardState())
    expect(currentUsageFor(state, 'am-1')).toBeNull()
  })

  test('chatTurns folds user messages and chat runs into a conversation', () => {
    const events = [
      ev(1, 'am-1', 1000, { type: 'chat.message', text: 'why no pr?' }),
      ev(2, 'am-1', 1100, {
        type: 'agent.started',
        role: 'chat',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'text', text: 'the work ' },
      }),
      ev(4, 'am-1', 1300, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'text', text: 'was already done' },
      }),
      ev(5, 'am-1', 1400, { type: 'agent.exited', role: 'chat', exitCode: 0, sessionId: 'sess-1' }),
      ev(6, 'am-1', 1500, { type: 'chat.message', text: 'can you show me?' }),
      ev(7, 'am-1', 1600, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'text', text: 'ignored' },
      }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(chatTurns(state, 'am-1')).toEqual([
      { id: 'u1', role: 'user', text: 'why no pr?', ts: 1000, pending: false },
      {
        id: 'a2',
        role: 'assistant',
        text: 'the work was already done',
        ts: 1100,
        pending: false,
      },
      { id: 'u6', role: 'user', text: 'can you show me?', ts: 1500, pending: false },
    ])
  })

  test('chatTurns marks an in-flight chat run as a pending assistant turn', () => {
    const events = [
      ev(1, 'am-1', 1000, { type: 'chat.message', text: 'hello' }),
      ev(2, 'am-1', 1100, {
        type: 'agent.started',
        role: 'chat',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'text', text: 'almost' },
      }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    const turns = chatTurns(state, 'am-1')
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'almost', pending: true })
    expect(chatInFlight(state, 'am-1')).toBe(true)
  })

  test('chatInFlight is false once the chat run exits', () => {
    const events = [
      ev(1, 'am-1', 1000, {
        type: 'agent.started',
        role: 'chat',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
      ev(2, 'am-1', 1100, { type: 'agent.exited', role: 'chat', exitCode: 0, sessionId: 'sess-1' }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(chatInFlight(state, 'am-1')).toBe(false)
  })

  test('a scheduled retry folds its fire time into the projection', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Retried', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1200, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1300, {
        type: 'retry.scheduled',
        attempt: 2,
        delayMs: 30_000,
        reason: 'transient harness failure',
        detail: 'rate limit exceeded',
      }),
      ev(5, 'am-1', 1400, { type: 'task.state', from: 'implementing', to: 'retrying' }),
    ].reduce(reduceState, initialDashboardState())

    expect(state.tasks['am-1']).toMatchObject({
      state: 'retrying',
      retryCount: 1,
      retryAt: 31_300,
    })
  })

  test('a deferred retry is absent from the needs-attention list', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Deferred', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1200, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1300, {
        type: 'retry.scheduled',
        attempt: 1,
        delayMs: 60_000,
        reason: 'transient harness failure',
        detail: 'quota exceeded',
      }),
      ev(5, 'am-1', 1400, { type: 'task.state', from: 'implementing', to: 'retrying' }),
      ev(6, 'am-2', 1500, { type: 'task.claimed', title: 'Stopped', tracker: 'bd' }),
      ev(7, 'am-2', 1600, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(8, 'am-2', 1700, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(9, 'am-2', 1800, {
        type: 'task.state',
        from: 'implementing',
        to: 'needs_human',
        reason: 'checks failing',
      }),
    ].reduce(reduceState, initialDashboardState())

    // Only the task actually stopped for a human needs attention; the deferred
    // automatic retry waits on its backoff, not on the operator.
    expect(tasksNeedingAttention(state).map((t) => t.id)).toEqual(['am-2'])
    expect(state.tasks['am-1']?.state).toBe('retrying')
  })
  test('completing a parked task keeps the verdict and the chat conversation', () => {
    const events = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1200, { type: 'worktree.created', path: '/tmp/am-1', branch: 'amagi/am-1' }),
      ev(4, 'am-1', 1300, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(5, 'am-1', 1400, {
        type: 'task.state',
        from: 'implementing',
        to: 'no_pr',
        reason: 'the work was already done',
      }),
      ev(6, 'am-1', 1500, { type: 'chat.message', text: 'why no pr?' }),
      ev(7, 'am-1', 1600, {
        type: 'agent.started',
        role: 'chat',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp/am-1',
        resumed: true,
      }),
      ev(8, 'am-1', 1700, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'text', text: 'it was already done' },
      }),
      ev(9, 'am-1', 1800, { type: 'agent.exited', role: 'chat', exitCode: 0, sessionId: 'sess-1' }),
      // The operator marks the task done: the verdict reason lands on the task
      // and the worktree is torn down, exactly as the close endpoint emits.
      ev(10, 'am-1', 1900, { type: 'task.state', from: 'no_pr', to: 'done', reason: 'completed' }),
      ev(11, 'am-1', 2000, { type: 'worktree.removed', path: '/tmp/am-1' }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    const task = state.tasks['am-1']
    expect(task?.state).toBe('done')
    expect(task?.statusReason).toBe('completed')
    // The verdict is not the conversation; the chat survives completion.
    expect(chatTurns(state, 'am-1')).toEqual([
      { id: 'u6', role: 'user', text: 'why no pr?', ts: 1500, pending: false },
      {
        id: 'a7',
        role: 'assistant',
        text: 'it was already done',
        ts: 1600,
        pending: false,
      },
    ])
  })

  test('a done task stays out of the active queue and attention list', () => {
    const events = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'no_pr', reason: 'parked' }),
      ev(3, 'am-1', 1200, { type: 'task.state', from: 'no_pr', to: 'done', reason: 'completed' }),
    ]
    const state = events.reduce(reduceState, initialDashboardState())
    expect(activeTasks(state).map((t) => t.id)).toEqual([])
    expect(tasksNeedingAttention(state).map((t) => t.id)).toEqual([])
  })
})

describe('run health', () => {
  const healthEvents = (): StoredEvent[] => [
    ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
    ev(2, 'am-1', 1100, {
      type: 'run.limits',
      contextWarnTokens: 150_000,
      contextMaxTokens: 200_000,
      maxRunMs: 3_600_000,
      maxCostUsd: 5,
    }),
    ev(3, 'am-1', 1200, {
      type: 'agent.started',
      role: 'implement',
      harness: 'claude',
      model: 'm',
      effort: null,
      cwd: '/tmp/am-1',
      resumed: false,
    }),
    ev(4, 'am-1', 1300, {
      type: 'agent.stream',
      role: 'implement',
      event: {
        kind: 'usage',
        inputTokens: 100_000,
        outputTokens: 10,
        cachedTokens: 20_000,
        costUsd: 1.5,
      },
    }),
    ev(5, 'am-1', 1400, { type: 'run.context', contextTokens: 120_000 }),
  ]

  test('folds limits, peak context, cost, elapsed and warnings from the stream', () => {
    const state = [...healthEvents()].reduce(reduceState, initialDashboardState())
    const health = runHealth(state, 'am-1', 2000)
    expect(health).toMatchObject({
      contextTokens: 120_000,
      contextWarnTokens: 150_000,
      contextMaxTokens: 200_000,
      costUsd: 1.5,
      costSeen: true,
      maxCostUsd: 5,
      elapsedMs: 1000,
      maxRunMs: 3_600_000,
      warnings: [],
    })
  })

  test('last run.context wins as the peak and a zero maxRunMs means unbounded', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, {
        type: 'run.limits',
        contextWarnTokens: 150_000,
        contextMaxTokens: 200_000,
        maxRunMs: 0,
        maxCostUsd: 0,
      }),
      ev(3, 'am-1', 1200, { type: 'run.context', contextTokens: 50 }),
      ev(4, 'am-1', 1300, { type: 'run.context', contextTokens: 80 }),
    ].reduce(reduceState, initialDashboardState())
    const health = runHealth(state, 'am-1', 1400)
    expect(health.contextTokens).toBe(80)
    expect(health.maxRunMs).toBeNull()
    expect(health.maxCostUsd).toBe(0)
    expect(runHealthNearLimit(health)).toBe(false)
  })

  test('chat usage cost is outside the task budget', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'Fix', tracker: 'bd' }),
      ev(2, 'am-1', 1100, {
        type: 'run.limits',
        contextWarnTokens: 150_000,
        contextMaxTokens: 200_000,
        maxRunMs: 0,
        maxCostUsd: 5,
      }),
      ev(3, 'am-1', 1200, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 2 },
      }),
      ev(4, 'am-1', 1300, {
        type: 'agent.stream',
        role: 'chat',
        event: { kind: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 99 },
      }),
    ].reduce(reduceState, initialDashboardState())
    const health = runHealth(state, 'am-1', 1400)
    expect(health.costUsd).toBe(2)
  })

  test('collects doom-loop and context guard warnings', () => {
    const state = [
      ...healthEvents(),
      ev(6, 'am-1', 1500, {
        type: 'doom.detected',
        kind: 'tool_repeat',
        detail: 'repeated the same command 21 times',
      }),
      ev(7, 'am-1', 1600, { type: 'run.context', contextTokens: 160_000 }),
      ev(8, 'am-1', 1700, { type: 'context.warn', contextTokens: 160_000, limit: 150_000 }),
    ].reduce(reduceState, initialDashboardState())
    const health = runHealth(state, 'am-1', 1800)
    expect(health.warnings).toEqual([
      'doom loop: repeated the same command 21 times',
      'context warning: 160000/150000 tokens',
    ])
    expect(runHealthNearLimit(health)).toBe(true)
  })

  test('flags a run nearing the soft context limit', () => {
    const events = [
      ...healthEvents(),
      ev(9, 'am-1', 1500, { type: 'run.context', contextTokens: 150_000 }),
    ].reduce(reduceState, initialDashboardState())
    expect(runHealthNearLimit(runHealth(events, 'am-1', 1600))).toBe(true)
  })

  test('flags a run past 80% of the time budget', () => {
    const events = [
      ...healthEvents(),
      ev(9, 'am-1', 1500, { type: 'run.context', contextTokens: 10 }),
    ].reduce(reduceState, initialDashboardState())
    // 1000ms claimed at t=1000; 3_600_000ms budget; 80% at 2_890_000ms in.
    const now = 1000 + 3_600_000 * 0.8
    expect(runHealthNearLimit(runHealth(events, 'am-1', now))).toBe(true)
  })

  test('flags a run past 80% of the cost budget', () => {
    const events = [
      ...healthEvents(),
      ev(9, 'am-1', 1500, { type: 'run.context', contextTokens: 10 }),
      ev(10, 'am-1', 1600, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 4.2 },
      }),
    ].reduce(reduceState, initialDashboardState())
    // 1.5 + 4.2 = 5.7 >= 80% of the $5 budget.
    expect(runHealthNearLimit(runHealth(events, 'am-1', 1700))).toBe(true)
  })
})

describe('status log', () => {
  test('lists every state with its timestamp, reason and time spent in it', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    const log = statusLog(state, 'am-1', 5000)
    expect(log.map((e) => [e.ts, e.from, e.to, e.durationMs])).toEqual([
      [1000, null, 'claimed', 100],
      [1100, 'claimed', 'worktree_ready', 200],
      [1300, 'worktree_ready', 'implementing', 200],
      [1500, 'implementing', 'checks', 200],
      [1700, 'checks', 'committed', 200],
      [1900, 'committed', 'pr_open', 100],
      [2000, 'pr_open', 'done', null],
    ])
  })

  test('an in-flight task counts its current state up to now, a settled view does not', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
    ].reduce(reduceState, initialDashboardState())
    expect(statusLog(state, 'am-1', 1600).at(-1)?.durationMs).toBe(500)
    expect(statusLog(state, 'am-1', null).at(-1)?.durationMs).toBeNull()
  })

  test('starts at the last reset and records reclaims with their reason', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1100, {
        type: 'task.state',
        from: 'claimed',
        to: 'cancelled',
        reason: 'operator interrupt',
      }),
      ev(3, 'am-1', 1200, { type: 'task.reset', reason: 'start over' }),
      ev(4, 'am-2', 1250, { type: 'task.claimed', title: 'Other', tracker: 'bd' }),
      ev(5, 'am-1', 1300, { type: 'task.state', from: 'claimed', to: 'needs_human' }),
      ev(6, 'am-1', 1400, { type: 'task.reclaimed', reason: 'stale lease' }),
    ].reduce(reduceState, initialDashboardState())
    expect(statusLog(state, 'am-1', null).map((e) => [e.cause, e.from, e.to, e.reason])).toEqual([
      ['reset', null, 'claimed', 'start over'],
      ['state', 'claimed', 'needs_human', null],
      ['reclaimed', 'needs_human', 'queued', 'stale lease'],
    ])
  })

  test('a past attempt keeps its own log', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'claimed', to: 'no_pr' }),
      ev(3, 'am-1', 1200, { type: 'task.reset' }),
    ].reduce(reduceState, initialDashboardState())
    const past = stateAtAttempt(state, 'am-1', 1)
    expect(statusLog(past, 'am-1', null).map((e) => e.to)).toEqual(['claimed', 'no_pr'])
  })

  test('nests verify and implement runs under the same implementing state', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1050, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1100, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1200, {
        type: 'agent.started',
        role: 'verify',
        harness: 'claude',
        model: 'sonnet',
        effort: 'high',
        cwd: '/tmp',
        resumed: false,
      }),
      ev(5, 'am-1', 1280, { type: 'agent.exited', role: 'verify', exitCode: 0, sessionId: null }),
      ev(6, 'am-1', 1300, {
        type: 'agent.started',
        role: 'implement',
        harness: 'claude',
        model: 'sonnet',
        effort: null,
        cwd: '/tmp',
        resumed: false,
      }),
      ev(7, 'am-1', 1500, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: 0,
        sessionId: null,
      }),
    ].reduce(reduceState, initialDashboardState())
    const implementing = statusLog(state, 'am-1', 1600).find((entry) => entry.to === 'implementing')
    expect(
      implementing?.runs.map((run) => [
        run.label,
        run.harness,
        run.model,
        run.durationMs,
        run.exitCode,
      ]),
    ).toEqual([
      ['verify', 'claude', 'sonnet', 80, 0],
      ['implement', 'claude', 'sonnet', 200, 0],
    ])
  })

  test('labels an implement run after checks as a fix and marks restarts', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1050, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1100, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1200, { type: 'task.state', from: 'implementing', to: 'checks' }),
      ev(5, 'am-1', 1300, { type: 'task.state', from: 'checks', to: 'implementing' }),
      ev(6, 'am-1', 1310, {
        type: 'run.restarted',
        phase: 'implement',
        restart: 2,
        contextTokens: 100,
        summary: 'continue',
      }),
      ev(7, 'am-1', 1320, {
        type: 'agent.started',
        role: 'implement',
        harness: 'codex',
        model: 'gpt',
        effort: null,
        cwd: '/tmp',
        resumed: false,
      }),
      ev(8, 'am-1', 1400, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: 1,
        sessionId: null,
      }),
    ].reduce(reduceState, initialDashboardState())
    const run = statusLog(state, 'am-1', null).find(
      (entry) => entry.to === 'implementing' && entry.runs.length > 0,
    )?.runs[0]
    expect(run?.label).toBe('implement (fix) (restart 2)')
  })

  test("uses only a run's usage events and keeps an in-flight run open", () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1050, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1100, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1200, {
        type: 'agent.started',
        role: 'implement',
        harness: 'opencode',
        model: null,
        effort: null,
        cwd: '/tmp',
        resumed: false,
      }),
      ev(5, 'am-1', 1210, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 10, outputTokens: 2, costUsd: 0.1 },
      }),
      ev(6, 'am-1', 1220, {
        type: 'agent.exited',
        role: 'implement',
        exitCode: 0,
        sessionId: null,
      }),
      ev(7, 'am-1', 1300, {
        type: 'agent.started',
        role: 'implement',
        harness: 'opencode',
        model: null,
        effort: null,
        cwd: '/tmp',
        resumed: true,
      }),
      ev(8, 'am-1', 1310, {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'usage', inputTokens: 30, outputTokens: 4 },
      }),
    ].reduce(reduceState, initialDashboardState())
    const runs = statusLog(state, 'am-1', 1500).find((entry) => entry.to === 'implementing')?.runs
    expect(runs?.map((run) => [run.inputTokens, run.outputTokens, run.costUsd])).toEqual([
      [10, 2, 0.1],
      [30, 4, null],
    ])
    expect(runs?.[1]).toMatchObject({
      label: 'implement (resumed)',
      durationMs: 200,
      exitCode: null,
    })
  })

  test('settles an open run when viewing a past attempt', () => {
    const state = [
      ev(1, 'am-1', 1000, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
      ev(2, 'am-1', 1050, { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
      ev(3, 'am-1', 1100, { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
      ev(4, 'am-1', 1200, {
        type: 'agent.started',
        role: 'verify',
        harness: 'claude',
        model: null,
        effort: null,
        cwd: '/tmp',
        resumed: false,
      }),
      ev(5, 'am-1', 1300, { type: 'task.reset' }),
      ev(6, 'am-1', 1400, { type: 'task.claimed', title: 'T', tracker: 'bd' }),
    ].reduce(reduceState, initialDashboardState())
    const past = stateAtAttempt(state, 'am-1', 1)
    expect(
      statusLog(past, 'am-1', null).find((entry) => entry.to === 'implementing')?.runs[0],
    ).toMatchObject({
      durationMs: null,
      exitCode: null,
    })
  })
})
