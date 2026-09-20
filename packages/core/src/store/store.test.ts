import { beforeEach, describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../events.ts'
import { openDatabase } from './db.ts'
import { InvalidTransitionError, Store } from './store.ts'

let store: Store

const claim = (id = 'bd-1') =>
  store.append(id, { type: 'task.claimed', title: 'Add SSE endpoint', tracker: 'beads' })

beforeEach(() => {
  store = new Store(openDatabase(':memory:'))
})

describe('Store', () => {
  test('claiming projects a task row', () => {
    claim()
    const t = store.task('bd-1')
    expect(t?.state).toBe('claimed')
    expect(t?.title).toBe('Add SSE endpoint')
    expect(t?.reviewRound).toBe(0)
  })

  test('sequence numbers are monotonic and returned', () => {
    const a = claim()
    const b = store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  test('illegal transitions are rejected and leave no event behind', () => {
    claim()
    expect(() =>
      store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'pr_open' }),
    ).toThrow(InvalidTransitionError)
    expect(store.task('bd-1')?.state).toBe('claimed')
    expect(store.events({ taskId: 'bd-1' })).toHaveLength(1)
  })

  test('tasks touched in the same millisecond keep a stable order', () => {
    claim('bd-1')
    claim('bd-2')
    claim('bd-3')
    const once = store.tasks().map((t) => t.id)
    expect(store.tasks().map((t) => t.id)).toEqual(once)
    expect(once).toEqual(['bd-3', 'bd-2', 'bd-1'])
  })

  test('worktree creation records path and branch', () => {
    claim()
    store.append('bd-1', {
      type: 'worktree.created',
      path: '/tmp/wt/amagi-bd-1-add-sse',
      branch: 'amagi/bd-1-add-sse',
    })
    const t = store.task('bd-1')
    expect(t?.worktree).toBe('/tmp/wt/amagi-bd-1-add-sse')
    expect(t?.branch).toBe('amagi/bd-1-add-sse')
  })

  test('entering review increments the round counter', () => {
    claim()
    for (const to of [
      'worktree_ready',
      'implementing',
      'checks',
      'committed',
      'pr_open',
      'reviewing',
    ] as const) {
      store.append('bd-1', { type: 'task.state', from: null, to })
    }
    expect(store.task('bd-1')?.reviewRound).toBe(1)
    store.append('bd-1', { type: 'task.state', from: 'reviewing', to: 'fixing' })
    store.append('bd-1', { type: 'task.state', from: 'fixing', to: 'reviewing' })
    expect(store.task('bd-1')?.reviewRound).toBe(2)
  })

  test('questions open then close', () => {
    claim()
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'Retries per-request or per-connection?',
      options: ['per-request', 'per-connection'],
      gateRef: 'gate-7',
    })
    expect(store.openQuestions()).toHaveLength(1)
    expect(store.openQuestions()[0]?.options).toEqual(['per-request', 'per-connection'])

    store.append('bd-1', {
      type: 'question.answered',
      questionId: 'q1',
      answer: 'per-request',
      via: 'web',
    })
    expect(store.openQuestions()).toHaveLength(0)
    expect(store.question('q1')?.answer).toBe('per-request')
  })

  test('a timed out question stops blocking', () => {
    claim()
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which?',
      options: [],
      gateRef: null,
    })
    store.append('bd-1', { type: 'question.timedout', questionId: 'q1' })
    expect(store.openQuestions()).toHaveLength(0)
    expect(store.question('q1')?.answer).toBeNull()
  })

  test('an unanswered question outlives its timeout until answered', () => {
    claim()
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which?',
      options: [],
      gateRef: null,
    })
    store.append('bd-1', { type: 'question.timedout', questionId: 'q1' })
    expect(store.unansweredQuestions()).toHaveLength(1)
    expect(store.openQuestions()).toHaveLength(0)

    store.append('bd-1', {
      type: 'question.answered',
      questionId: 'q1',
      answer: 'npm',
      via: 'web',
    })
    expect(store.unansweredQuestions()).toHaveLength(0)
    expect(store.openQuestions()).toHaveLength(0)
  })

  test('agent exit captures the session id for later resume', () => {
    claim()
    store.append('bd-1', {
      type: 'agent.exited',
      role: 'implement',
      exitCode: 0,
      sessionId: 'sess-42',
    })
    expect(store.task('bd-1')?.sessionId).toBe('sess-42')
  })

  test('rebuild reproduces the projection exactly', () => {
    claim()
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'worktree.created', path: '/tmp/wt/x', branch: 'amagi/bd-1-x' })
    store.append('bd-1', {
      type: 'question.asked',
      questionId: 'q1',
      question: 'which?',
      options: ['a'],
      gateRef: null,
    })
    const before = store.task('bd-1')
    const questionsBefore = store.openQuestions()

    store.rebuild()

    expect(store.task('bd-1')).toEqual(before)
    expect(store.openQuestions()).toEqual(questionsBefore)
  })

  test('subscribers see appended events', () => {
    const seen: StoredEvent[] = []
    const unsubscribe = store.subscribe((e) => seen.push(e))
    claim()
    unsubscribe()
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('task.claimed')
  })

  test('events can be tailed from a sequence number', () => {
    const first = claim()
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const tail = store.events({ taskId: 'bd-1', sinceSeq: first.seq })
    expect(tail).toHaveLength(1)
    expect(tail[0]?.type).toBe('task.state')
  })

  test('tasks can be filtered by state', () => {
    claim('bd-1')
    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'abandoned' })
    expect(store.tasks({ states: ['claimed'] }).map((t) => t.id)).toEqual(['bd-1'])
  })
})
