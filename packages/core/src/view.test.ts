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
  reduceState,
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
    expect(state.tasks['am-1']?.state).toBe('claimed')
    expect(state.tasks['am-1']?.worktree).toBe('/tmp/am-1')
    expect(state.tasks['am-1']?.branch).toBe('x')
    expect(activeTasks(state).map((t) => t.id)).toEqual(['am-1'])
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
