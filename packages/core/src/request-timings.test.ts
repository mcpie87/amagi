import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RequestSample, RequestTimings, requestSource } from './request-timings.ts'

const sample = (
  route: string,
  ms: number,
  over: Partial<RequestSample> = {},
): Omit<RequestSample, 'id'> => ({
  at: 1000,
  method: 'GET',
  route,
  path: route,
  query: '',
  source: 'page /',
  referer: null,
  userAgent: null,
  status: 200,
  ms,
  ...over,
})

describe('RequestTimings', () => {
  test('aggregates per method and route, heaviest total first', () => {
    const timings = new RequestTimings()
    for (const ms of [10, 20, 30, 40, 100]) timings.record(sample('/api/a', ms))
    timings.record(sample('/api/b', 500, { status: 503 }))
    timings.record(sample('/api/a', 1, { method: 'POST' }))

    const { routes, total } = timings.snapshot()
    expect(total).toBe(7)
    expect(routes.map((r) => `${r.method} ${r.route}`)).toEqual([
      'GET /api/b',
      'GET /api/a',
      'POST /api/a',
    ])
    expect(routes[0]?.errors).toBe(1)
    expect(routes[1]).toMatchObject({
      count: 5,
      totalMs: 200,
      avgMs: 40,
      p50Ms: 30,
      p95Ms: 100,
      maxMs: 100,
    })
  })

  test('aggregates per source, heaviest total first', () => {
    const timings = new RequestTimings()
    timings.record(sample('/api/a', 10, { source: 'page /issues' }))
    timings.record(sample('/api/b', 30, { source: 'page /issues', status: 500 }))
    timings.record(sample('/api/a', 5, { source: 'client Bun/1.3' }))

    expect(timings.snapshot().sources).toEqual([
      { source: 'page /issues', count: 2, errors: 1, totalMs: 40, avgMs: 20, lastAt: 1000 },
      { source: 'client Bun/1.3', count: 1, errors: 0, totalMs: 5, avgMs: 5, lastAt: 1000 },
    ])
  })

  test('filters by request, source, time and duration before aggregating', () => {
    const timings = new RequestTimings()
    timings.record(sample('/api/repos/r/runner', 50, { at: 100, source: 'page /fleet' }))
    timings.record(sample('/api/repos/r/runner', 400, { at: 200, source: 'page /fleet' }))
    timings.record(sample('/api/repos/r/runner', 600, { at: 300, source: 'client Bun/1.3' }))
    timings.record(sample('/api/health', 500, { at: 250, source: 'page /fleet' }))

    const snapshot = timings.snapshot({
      request: 'get /API/repos',
      source: 'FLEET',
      from: 150,
      to: 300,
      minMs: 100,
      maxMs: 500,
    })
    expect(snapshot.total).toBe(4)
    expect(snapshot.matched).toBe(1)
    expect(snapshot.recent.map((s) => s.at)).toEqual([200])
    expect(snapshot.routes.map((r) => r.count)).toEqual([1])
    expect(snapshot.sources.map((s) => s.totalMs)).toEqual([400])
  })

  test('filters by exact method and route pattern', () => {
    const timings = new RequestTimings()
    timings.record(sample('/api/repos/:repo', 10))
    timings.record(sample('/api/repos/:repo', 20, { method: 'POST' }))
    timings.record(sample('/api/repos/:repo/runner', 30))

    const snapshot = timings.snapshot({ method: 'GET', route: '/api/repos/:repo' })
    expect(snapshot.recent.map((s) => s.ms)).toEqual([10])
  })

  test('prunes samples older than the retention window', () => {
    const hour = 60 * 60 * 1000
    const timings = new RequestTimings(':memory:', hour)
    timings.record(sample('/api/old', 1, { at: 1 }))
    timings.record(sample('/api/a', 2, { at: 2 * hour }))
    timings.record(sample('/api/b', 3, { at: 2 * hour + 1 }))

    const snapshot = timings.snapshot()
    expect(snapshot.windowStart).toBe(2 * hour)
    expect(snapshot.recent.map((s) => s.route)).toEqual(['/api/b', '/api/a'])
    expect(snapshot.slowest.map((s) => s.ms)).toEqual([3, 2])
  })

  test('keeps samples across reopening the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-timings-'))
    try {
      const path = join(dir, 'timings.db')
      const first = new RequestTimings(path)
      first.record(sample('/api/a', 7, { at: Date.now() }))
      first.close()

      const second = new RequestTimings(path)
      expect(second.snapshot().recent.map((s) => [s.route, s.ms])).toEqual([['/api/a', 7]])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('matches LIKE wildcards in a search literally', () => {
    const timings = new RequestTimings()
    timings.record(sample('/api/a_b', 1))
    timings.record(sample('/api/axb', 2))

    expect(timings.snapshot({ request: 'a_b' }).recent.map((s) => s.route)).toEqual(['/api/a_b'])
  })
})

describe('requestSource', () => {
  test('prefers the referring page path, then the user agent', () => {
    expect(requestSource('http://localhost:5173/repos/r/issues?x=1', 'Mozilla/5.0')).toBe(
      'page /repos/r/issues',
    )
    expect(requestSource(undefined, 'Bun/1.3.0')).toBe('client Bun/1.3.0')
    expect(requestSource('not a url', undefined)).toBe('unknown')
  })
})
