import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '@amagi/core'
import {
  activeTasks,
  currentAgentFor,
  initialDashboardState,
  openQuestionsFor,
  reduceState,
  tasksNeedingAttention,
} from './state.ts'

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
  ev(11, 'am-1', 2000, { type: 'task.state', from: 'pr_open', to: 'reviewing' }),
  ev(12, 'am-1', 2100, { type: 'task.state', from: 'reviewing', to: 'done' }),
  ev(13, 'am-2', 2200, { type: 'task.claimed', title: 'Second task', tracker: 'bd' }),
  ev(14, 'am-2', 2300, {
    type: 'question.asked',
    questionId: 'q-1',
    question: 'Which port?',
    options: ['8080', '4321'],
    gateRef: null,
  }),
  ev(15, 'am-2', 2400, {
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
    expect(b.latestSeq).toBe(15)
  })

  test('folding projects tasks, review rounds, worktree, branch, PR and checks', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    const done = state.tasks['am-1']
    expect(done?.title).toBe('Fix the thing')
    expect(done?.state).toBe('done')
    expect(done?.reviewRound).toBe(1)
    expect(done?.worktree).toBe('/tmp/amagi/am-1')
    expect(done?.branch).toBe('fix-the-thing')
    expect(done?.prUrl).toBe('https://github.com/x/amagi/pull/1')
    expect(done?.prNumber).toBe(1)
    expect(done?.checks).toEqual([{ command: 'bun run check', exitCode: 1, output: 'type error' }])
    expect(done?.checksOk).toBe(false)
    expect(done?.lastCommit?.sha).toBe('abc123')
    expect(done?.createdAt).toBe(1000)
    expect(done?.updatedAt).toBe(2100)
  })

  test('review round increments once per reviewing entry', () => {
    const withSecondReview = [
      ...recorded,
      ev(16, 'am-1', 2500, { type: 'task.state', from: 'done', to: 'fixing' }),
      ev(17, 'am-1', 2600, { type: 'task.state', from: 'fixing', to: 'reviewing' }),
    ]
    const state = withSecondReview.reduce(reduceState, initialDashboardState())
    expect(state.tasks['am-1']?.reviewRound).toBe(2)
  })

  test('queue view lists only in-flight tasks, most recent first', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    const queue = activeTasks(state)
    expect(queue.map((t) => t.id)).toEqual(['am-2'])
    expect(queue[0]?.state).toBe('claimed')
  })

  test('attention list includes only tasks stopped for a human', () => {
    const state = [
      ...recorded,
      ev(16, 'am-1', 2500, { type: 'task.state', from: 'done', to: 'needs_human' }),
      ev(17, 'am-3', 2600, { type: 'task.claimed', title: 'Still running', tracker: 'bd' }),
    ].reduce(reduceState, initialDashboardState())

    expect(tasksNeedingAttention(state).map((t) => t.id)).toEqual(['am-1'])
  })

  test('questions resolve from events', () => {
    const state = recorded.reduce(reduceState, initialDashboardState())
    expect(openQuestionsFor(state, 'am-2')).toEqual([])
    const before = recorded.filter((e) => e.seq !== 15).reduce(reduceState, initialDashboardState())
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
})
