import { describe, expect, test } from 'bun:test'
import { type InteractionRecord, InteractionTracker } from './interactions.ts'

/** A hand-cranked clock: timers fire and frames paint only when the test advances. */
function harness() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let paints: (() => void)[] = []
  const records: InteractionRecord[] = []
  const tracker = new InteractionTracker({
    now: () => now,
    wallNow: () => 1_000_000 + now,
    afterPaint: (callback) => paints.push(callback),
    setTimeout: (callback, ms) => {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (timer) => timers.delete(timer as unknown as number),
    emit: (record) => records.push(record),
  })
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort(([, a], [, b]) => a.at - b.at)[0]
      if (due === undefined) break
      timers.delete(due[0])
      now = due[1].at
      due[1].callback()
    }
    now = until
  }
  const paint = (ms: number) => {
    advance(ms)
    const pending = paints
    paints = []
    for (const callback of pending) callback()
  }
  return { tracker, advance, paint, records }
}

const target = {
  kind: 'click' as const,
  action: 'button "mention"',
  context: null,
  route: '/',
  path: '/',
}

describe('InteractionTracker', () => {
  test('settles at the first paint when nothing was requested', () => {
    const h = harness()
    h.tracker.begin(target, 0)
    h.paint(16)
    h.advance(200)
    expect(h.records).toEqual([
      {
        ...target,
        at: 1_000_000,
        paintMs: 16,
        ms: 16,
        outcome: 'settled',
        requests: [],
      },
    ])
  })

  test('waits for requests, including one chained within the grace window', () => {
    const h = harness()
    h.tracker.begin(target, 0)
    const first = h.tracker.request('GET', '/api/a')
    h.paint(16)
    h.advance(100)
    first?.(200)
    h.paint(10)
    h.advance(50)
    const chained = h.tracker.request('GET', '/api/b')
    h.advance(200)
    expect(h.records).toEqual([])
    chained?.(404)
    h.paint(16)
    h.advance(200)
    expect(h.records[0]).toMatchObject({ paintMs: 16, ms: 392, outcome: 'settled' })
    expect(h.records[0]?.requests).toEqual([
      { method: 'GET', path: '/api/a', startMs: 0, ms: 116, status: 200 },
      { method: 'GET', path: '/api/b', startMs: 176, ms: 200, status: 404 },
    ])
  })

  test('a new input supersedes the open interaction, leaving its request in flight', () => {
    const h = harness()
    h.tracker.begin(target, 0)
    const done = h.tracker.request('POST', '/api/slow')
    h.paint(16)
    h.advance(500)
    h.tracker.begin({ ...target, kind: 'key', action: 'Escape' }, 516)
    done?.(200)
    h.paint(16)
    h.advance(200)
    expect(h.records.map((r) => [r.action, r.outcome, r.ms])).toEqual([
      ['button "mention"', 'superseded', 516],
      ['Escape', 'settled', 16],
    ])
    expect(h.records[0]?.requests[0]).toMatchObject({ ms: null, status: null })
  })

  test('gives up at the timeout when a request never ends', () => {
    const h = harness()
    h.tracker.begin(target, 0)
    h.tracker.request('GET', '/api/hang')
    h.paint(16)
    h.advance(20_000)
    expect(h.records[0]).toMatchObject({ outcome: 'timeout', ms: 15_000 })
    expect(h.tracker.request('GET', '/api/after')).toBeNull()
  })
})
