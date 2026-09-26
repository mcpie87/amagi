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
  test('activeChatAgents reports only chats without an exit event', () => {
    store.append('bd-1', {
      type: 'agent.started',
      role: 'chat',
      harness: 'claude',
      seat: 'claude-seat',
      model: null,
      effort: null,
      cwd: '/repo',
      resumed: false,
    })
    store.append('bd-2', {
      type: 'agent.started',
      role: 'chat',
      harness: 'codex',
      seat: 'codex-seat',
      model: null,
      effort: null,
      cwd: '/repo',
      resumed: false,
    })
    expect(store.activeChatAgents()).toEqual([
      { taskId: 'bd-1', seat: 'claude-seat' },
      { taskId: 'bd-2', seat: 'codex-seat' },
    ])

    store.append('bd-1', {
      type: 'agent.exited',
      role: 'chat',
      exitCode: 0,
      sessionId: 'session-1',
    })
    expect(store.activeChatAgents()).toEqual([{ taskId: 'bd-2', seat: 'codex-seat' }])
  })

  test('claiming projects a task row', () => {
    claim()
    const t = store.task('bd-1')
    expect(t?.state).toBe('claimed')
    expect(t?.title).toBe('Add SSE endpoint')
  })

  test('sequence numbers are monotonic and returned', () => {
    const a = claim()
    const b = store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    expect(b.seq).toBeGreaterThan(a.seq)
  })

  test('re-claiming a terminal task resets it to claimed', () => {
    claim()
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'needs_human' })
    expect(store.task('bd-1')?.state).toBe('needs_human')
    claim()
    expect(store.task('bd-1')?.state).toBe('claimed')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    expect(store.task('bd-1')?.state).toBe('worktree_ready')
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

  test('reclaiming a stuck task returns it to queued and keeps the worktree', () => {
    claim()
    store.append('bd-1', {
      type: 'worktree.created',
      path: '/tmp/wt/amagi-bd-1-add-sse',
      branch: 'amagi/bd-1-add-sse',
    })
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append('bd-1', { type: 'task.reclaimed' })
    const t = store.task('bd-1')
    expect(t?.state).toBe('queued')
    expect(t?.worktree).toBe('/tmp/wt/amagi-bd-1-add-sse')
    expect(t?.branch).toBe('amagi/bd-1-add-sse')
  })

  test('reclaimed tasks can be claimed and worked again', () => {
    claim()
    store.append('bd-1', {
      type: 'worktree.created',
      path: '/tmp/wt/x',
      branch: 'amagi/bd-1-x',
    })
    store.append('bd-1', { type: 'task.reclaimed' })
    claim()
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    expect(store.task('bd-1')?.state).toBe('worktree_ready')
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

  test('task.state reason surfaces as statusReason and clears on the next transition', () => {
    claim()
    expect(store.task('bd-1')?.statusReason).toBeNull()
    store.append('bd-1', {
      type: 'task.state',
      from: null,
      to: 'needs_human',
      reason: 'project checks still failing',
    })
    expect(store.task('bd-1')?.statusReason).toBe('project checks still failing')
    store.append('bd-1', { type: 'task.reclaimed' })
    expect(store.task('bd-1')?.statusReason).toBeNull()
    store.append('bd-1', { type: 'task.state', from: null, to: 'worktree_ready' })
    expect(store.task('bd-1')?.statusReason).toBeNull()
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

  test('retry.scheduled increments the persisted retry counter', () => {
    claim()
    store.append('bd-1', {
      type: 'retry.scheduled',
      attempt: 1,
      delayMs: 1000,
      reason: 'transient harness failure',
      detail: 'rate limit exceeded',
    })
    expect(store.task('bd-1')?.retryCount).toBe(1)
    store.append('bd-1', {
      type: 'retry.scheduled',
      attempt: 2,
      delayMs: 2000,
      reason: 'transient harness failure',
      detail: 'rate limit exceeded',
    })
    expect(store.task('bd-1')?.retryCount).toBe(2)
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

  test('heartbeat records activity without appending an event', () => {
    claim()
    store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-1')
    store.heartbeat('bd-1')
    expect(store.events({ taskId: 'bd-1' })).toHaveLength(1)
    expect(store.stalledTasks(['claimed'], Date.now() - 60_000)).toHaveLength(0)
  })

  test('stalledTasks finds only stale in-progress tasks, using updated_at when unheartbeated', () => {
    claim('bd-1')
    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.heartbeat('bd-1')
    store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-1')

    claim('bd-2')
    store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-2', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.db.query('update tasks set updated_at = ? where id = ?').run(Date.now() - 120_000, 'bd-2')

    claim('bd-3')
    store.append('bd-3', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-3', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })

    claim('bd-4')
    store.append('bd-4', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    store.append('bd-4', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
    store.append('bd-4', { type: 'task.state', from: 'implementing', to: 'checks' })
    store.append('bd-4', { type: 'task.state', from: 'checks', to: 'committed' })
    store.append('bd-4', { type: 'task.state', from: 'committed', to: 'pr_open' })
    store.append('bd-4', { type: 'task.state', from: 'pr_open', to: 'done' })

    const past = Date.now() - 60_000
    const stalled = store.stalledTasks(['implementing'], past)
    expect(stalled.map((t) => t.id)).toEqual(['bd-2'])
  })

  test('stalledTasks ignores a previous attempt heartbeat once the task is claimed again', () => {
    claim('bd-1')
    store.heartbeat('bd-1')
    store.db
      .query('update tasks set last_heartbeat_at = ? where id = ?')
      .run(Date.now() - 7_200_000, 'bd-1')
    store.append('bd-1', { type: 'task.reclaimed', reason: 'stalled' })
    expect(store.stalledTasks(['queued'], Date.now() - 60_000)).toHaveLength(0)
  })

  test('task.reclaimed carries the reason into statusReason', () => {
    claim()
    store.append('bd-1', {
      type: 'task.reclaimed',
      reason: 'recovered by stall watcher: no worker activity for 1h',
    })
    expect(store.task('bd-1')?.state).toBe('queued')
    expect(store.task('bd-1')?.statusReason).toBe(
      'recovered by stall watcher: no worker activity for 1h',
    )
  })

  test('recentEvents returns the newest events in order', () => {
    claim()
    for (const [from, to] of [
      ['claimed', 'worktree_ready'],
      ['worktree_ready', 'implementing'],
    ] as const) {
      store.append('bd-1', { type: 'task.state', from, to })
    }
    const recent = store.recentEvents('bd-1', 2)
    expect(recent.map((e) => (e.type === 'task.state' ? e.to : e.type))).toEqual([
      'worktree_ready',
      'implementing',
    ])
    expect(store.recentEvents('bd-1', 0)).toEqual([])
  })

  test('a run left open when the same watcher starts again is closed as interrupted', () => {
    const started = (name: string, runId: string) =>
      store.append(null, { type: 'watcher.run.started', repo: 'repo', name, runId })
    started('pr-conflict-watcher', 'dead')
    started('mention-watcher', 'other')
    started('pr-conflict-watcher', 'next')

    const runs = store.watcherRuns({ repo: 'repo', name: 'pr-conflict-watcher', limit: 5 })
    expect(runs.map((r) => [r.runId, r.ok, r.endedAt === null])).toEqual([
      ['next', null, true],
      ['dead', false, false],
    ])
    expect(runs[1]?.error).toContain('interrupted')
    const other = store.watcherRuns({ repo: 'repo', name: 'mention-watcher', limit: 5 })
    expect(other[0]?.endedAt).toBeNull()
  })

  test('watcherRuns folds durable run and action events and pages complete runs newest first', () => {
    for (const runId of ['one', 'two']) {
      store.append(null, {
        type: 'watcher.run.started',
        repo: 'repo',
        name: 'mention-watcher',
        runId,
      })
      store.append(null, {
        type: 'watcher.action',
        repo: 'repo',
        name: 'mention-watcher',
        runId,
        targetType: 'mention',
        targetId: runId,
        prNumber: 45,
        result: 'classified as explain',
        level: 'info',
      })
      store.append(null, {
        type: 'watcher.run.finished',
        repo: 'repo',
        name: 'mention-watcher',
        runId,
        ok: true,
      })
    }
    const page = store.watcherRuns({ repo: 'repo', name: 'mention-watcher', limit: 1 })
    expect(page).toHaveLength(1)
    expect(page[0]?.runId).toBe('two')
    expect(page[0]?.actions[0]?.prNumber).toBe(45)
    expect(page[0]?.ok).toBe(true)
    const beforeSeq = page[0]?.startSeq
    expect(
      store.watcherRuns({
        repo: 'repo',
        name: 'mention-watcher',
        limit: 1,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })[0]?.runId,
    ).toBe('one')
  })
})
