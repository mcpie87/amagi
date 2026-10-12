import { describe, expect, test } from 'bun:test'
import { type InteractionSample, InteractionTimings } from './interaction-timings.ts'

const sample = (
  action: string,
  ms: number,
  over: Partial<InteractionSample> = {},
): Omit<InteractionSample, 'id'> => ({
  at: Date.now(),
  kind: 'click',
  action,
  context: null,
  route: '/repos/$repo',
  path: '/repos/r1',
  paintMs: 8,
  ms,
  outcome: 'settled',
  requests: [],
  ...over,
})

describe('InteractionTimings', () => {
  test('aggregates per action, dialog and route; percentiles cover settled samples only', () => {
    const timings = new InteractionTimings()
    timings.record([
      sample('button "mention"', 40, { paintMs: 20 }),
      sample('button "mention"', 60, { paintMs: 30 }),
      sample('button "mention"', 900, { outcome: 'superseded', paintMs: null }),
      sample('button "Close"', 10, { context: 'mention' }),
      sample('button "Close"', 12, { context: 'Settings' }),
    ])

    const snapshot = timings.snapshot()
    expect(snapshot.total).toBe(5)
    expect(snapshot.actions.map((a) => [a.action, a.context, a.count])).toEqual([
      ['button "mention"', null, 3],
      ['button "Close"', 'Settings', 1],
      ['button "Close"', 'mention', 1],
    ])
    expect(snapshot.actions[0]).toMatchObject({
      unsettled: 1,
      p50PaintMs: 20,
      p95PaintMs: 30,
      p50Ms: 40,
      maxMs: 60,
      totalMs: 100,
    })
    expect(snapshot.slowest[0]?.outcome).toBe('superseded')
  })

  test('filters by action or dialog, page, kind and duration; keeps the request list', () => {
    const timings = new InteractionTimings()
    const requests = [
      { method: 'GET', path: '/api/x?y=1', startMs: 2, ms: 30, status: 200 },
      { method: 'POST', path: '/api/z', startMs: 5, ms: null, status: null },
    ]
    timings.record([
      sample('button "Close"', 10, { context: 'mention watcher' }),
      sample('Escape', 300, { kind: 'key', route: '/diagnostics', path: '/diagnostics', requests }),
    ])

    const actions = (filter: Parameters<InteractionTimings['snapshot']>[0]) =>
      timings.snapshot(filter).recent.map((s) => s.action)
    expect(actions({ action: 'WATCHER' })).toEqual(['button "Close"'])
    expect(actions({ page: 'diag' })).toEqual(['Escape'])
    expect(actions({ kind: 'click' })).toEqual(['button "Close"'])
    expect(actions({ minMs: 100 })).toEqual(['Escape'])
    expect(timings.snapshot({ kind: 'key' }).recent[0]?.requests).toEqual(requests)
    expect(timings.snapshot({ action: 'none' })).toMatchObject({ total: 2, matched: 0 })
  })

  test('prunes samples older than the retention window', () => {
    const timings = new InteractionTimings(':memory:', 1000)
    timings.record([sample('old', 1, { at: Date.now() - 5000 }), sample('new', 1)])
    expect(timings.snapshot().recent.map((s) => s.action)).toEqual(['new'])
  })
})
