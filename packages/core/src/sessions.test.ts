import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from './events.ts'
import { sessionsFromEvents } from './sessions.ts'

function ev(seq: number, taskId: string | null, ts: number, body: object): StoredEvent {
  return { seq, ts, taskId, ...body } as StoredEvent
}

const start = (seq: number, taskId: string, ts: number, extra: object = {}) =>
  ev(seq, taskId, ts, {
    type: 'agent.started',
    role: 'implement',
    harness: 'claude',
    model: 'claude-opus-5',
    effort: null,
    cwd: '/tmp/wt',
    resumed: false,
    ...extra,
  })

const usage = (seq: number, taskId: string, ts: number, body: object) =>
  ev(seq, taskId, ts, {
    type: 'agent.stream',
    role: 'implement',
    event: { kind: 'usage', ...body },
  })

const exit = (seq: number, taskId: string, ts: number, extra: object = {}) =>
  ev(seq, taskId, ts, {
    type: 'agent.exited',
    role: 'implement',
    exitCode: 0,
    sessionId: 'sess-1',
    ...extra,
  })

describe('sessionsFromEvents', () => {
  test('folds one run into a session with duration and accumulated usage', () => {
    const events = [
      start(1, 'am-1', 1000),
      usage(2, 'am-1', 1100, { inputTokens: 100, outputTokens: 50, cachedTokens: 300 }),
      usage(3, 'am-1', 1200, { inputTokens: 20, outputTokens: 10, cachedTokens: 40 }),
      exit(4, 'am-1', 2000, { sessionId: 'sess-1' }),
    ]
    expect(sessionsFromEvents(events)).toEqual([
      {
        taskId: 'am-1',
        sessionId: 'sess-1',
        role: 'implement',
        harness: 'claude',
        model: 'claude-opus-5',
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
        exitCode: 0,
        usedTokens: 180,
        cachedTokens: 340,
        costUsd: 0,
      },
    ])
  })

  test('keeps a run without an exit as an in-flight session', () => {
    const events = [
      start(1, 'am-1', 1000),
      usage(2, 'am-1', 1100, { inputTokens: 5, outputTokens: 5 }),
    ]
    const sessions = sessionsFromEvents(events)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ endedAt: null, durationMs: null, exitCode: null })
    expect(sessions[0]?.usedTokens).toBe(10)
  })

  test('a retry yields one session per run with separate token counts', () => {
    const events = [
      start(1, 'am-1', 1000, { harness: 'codex', model: 'gpt-5.1-codex' }),
      usage(2, 'am-1', 1100, { inputTokens: 100, outputTokens: 10 }),
      exit(3, 'am-1', 2000),
      start(4, 'am-1', 3000, { harness: 'codex', model: 'gpt-5.1-codex' }),
      usage(5, 'am-1', 3100, { inputTokens: 50, outputTokens: 5 }),
      exit(6, 'am-1', 4000),
    ]
    const sessions = sessionsFromEvents(events)
    expect(sessions).toHaveLength(2)
    expect(sessions.map((s) => s.usedTokens)).toEqual([110, 55])
    expect(sessions.map((s) => s.harness)).toEqual(['codex', 'codex'])
  })

  test('review runs fold into their own session', () => {
    const events = [
      start(1, 'am-1', 1000, { role: 'implement' }),
      exit(2, 'am-1', 2000),
      start(3, 'am-1', 3000, { role: 'review', harness: 'codex', model: 'gpt-5.1-codex' }),
      exit(4, 'am-1', 4000, { role: 'review', sessionId: 'sess-review' }),
    ]
    const sessions = sessionsFromEvents(events)
    expect(sessions.map((s) => s.role)).toEqual(['implement', 'review'])
    expect(sessions[1]?.sessionId).toBe('sess-review')
  })

  test('usage outside an open session is ignored', () => {
    const events = [usage(1, 'am-1', 1000, { inputTokens: 100, outputTokens: 10 })]
    expect(sessionsFromEvents(events)).toEqual([])
  })

  test('non-agent events do not disturb session folding', () => {
    const events = [
      start(1, 'am-1', 1000),
      ev(2, 'am-1', 1100, { type: 'task.state', from: 'implementing', to: 'checks' }),
      exit(3, 'am-1', 2000),
    ]
    const sessions = sessionsFromEvents(events)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.durationMs).toBe(1000)
  })
})
