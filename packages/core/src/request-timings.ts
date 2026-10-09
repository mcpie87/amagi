import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type RequestSample = {
  /** Row id in the timings database; stable across snapshots and restarts. */
  id: number
  at: number
  method: string
  /** The registered route pattern, so `/api/repos/a/x` and `/api/repos/b/x` aggregate together. */
  route: string
  path: string
  /** Raw query string without the leading `?`; empty when there is none. */
  query: string
  /** Dashboard page (from Referer) or client User-Agent; see `requestSource`. */
  source: string
  referer: string | null
  userAgent: string | null
  status: number
  ms: number
}

export type RouteTiming = {
  method: string
  route: string
  count: number
  errors: number
  totalMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  lastAt: number
}

export type SourceTiming = {
  source: string
  count: number
  errors: number
  totalMs: number
  avgMs: number
  lastAt: number
}

/** Every set field must match; bounds are inclusive. */
export type TimingFilter = {
  /** Substring of `METHOD path`, case-insensitive for ASCII. */
  request?: string | undefined
  /** Substring of the source, case-insensitive for ASCII. */
  source?: string | undefined
  /** Exact method, for drilling into one route. */
  method?: string | undefined
  /** Exact route pattern, as in `RequestSample.route`. */
  route?: string | undefined
  from?: number | undefined
  to?: number | undefined
  minMs?: number | undefined
  maxMs?: number | undefined
}

export type TimingSnapshot = {
  /** Timestamp of the oldest sample still held, or null before the first request. */
  windowStart: number | null
  /** Samples held, before filtering. */
  total: number
  /** Samples the filter kept. */
  matched: number
  /** The newest matching samples, at most ANALYSIS_LIMIT; everything below is computed from these. */
  analysed: number
  /** How long a sample is held before it is pruned. */
  retentionMs: number
  /** Heaviest first by total time spent, which is what makes the UI feel slow. */
  routes: RouteTiming[]
  /** Heaviest first by total time spent. */
  sources: SourceTiming[]
  slowest: RequestSample[]
  /** Newest first. */
  recent: RequestSample[]
  /** Null until the event-loop monitor has taken a reading. */
  eventLoop: { lagMs: number; maxLagMs: number } | null
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const ANALYSIS_LIMIT = 5000
const LIST_LIMIT = 50
const LAG_INTERVAL_MS = 500
const LAG_WINDOW = 120

/**
 * Names who made a request: the dashboard page that was open (same-origin
 * fetches and EventSource send it as Referer), else the client's User-Agent.
 */
export function requestSource(referer: string | undefined, userAgent: string | undefined): string {
  if (referer) {
    try {
      return `page ${new URL(referer).pathname}`
    } catch {}
  }
  return userAgent ? `client ${userAgent}` : 'unknown'
}

function groupBy(samples: RequestSample[], key: (s: RequestSample) => string): RequestSample[][] {
  const groups = new Map<string, RequestSample[]>()
  for (const sample of samples) {
    const k = key(sample)
    const group = groups.get(k)
    if (group === undefined) groups.set(k, [sample])
    else group.push(sample)
  }
  return [...groups.values()]
}

type Row = {
  id: number
  at: number
  method: string
  route: string
  path: string
  query: string
  source: string
  referer: string | null
  user_agent: string | null
  status: number
  ms: number
}

const toSample = (r: Row): RequestSample => ({
  id: r.id,
  at: r.at,
  method: r.method,
  route: r.route,
  path: r.path,
  query: r.query,
  source: r.source,
  referer: r.referer,
  userAgent: r.user_agent,
  status: r.status,
  ms: r.ms,
})

function openTimingsDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('pragma journal_mode = WAL')
  // One insert per API request: skip the per-commit fsync. WAL keeps the file
  // consistent; a power loss costs only the last few samples.
  db.exec('pragma synchronous = NORMAL')
  db.exec('pragma busy_timeout = 5000')
  db.exec(`
    create table if not exists requests (
      id         integer primary key autoincrement,
      at         integer not null,
      method     text not null,
      route      text not null,
      path       text not null,
      query      text not null,
      source     text not null,
      referer    text,
      user_agent text,
      status     integer not null,
      ms         real not null
    );
    create index if not exists requests_at_idx on requests (at);
  `)
  return db
}

const likeAny = (value: string): string => `%${value.replace(/[\\%_]/g, '\\$&')}%`

function whereClause(filter: TimingFilter): { sql: string; params: SQLQueryBindings[] } {
  const clauses: string[] = []
  const params: SQLQueryBindings[] = []
  const add = (clause: string, value: SQLQueryBindings) => {
    clauses.push(clause)
    params.push(value)
  }
  if (filter.request) add(`(method || ' ' || path) like ? escape '\\'`, likeAny(filter.request))
  if (filter.source) add(`source like ? escape '\\'`, likeAny(filter.source))
  if (filter.method !== undefined) add('method = ?', filter.method)
  if (filter.route !== undefined) add('route = ?', filter.route)
  if (filter.from !== undefined) add('at >= ?', filter.from)
  if (filter.to !== undefined) add('at <= ?', filter.to)
  if (filter.minMs !== undefined) add('ms >= ?', filter.minMs)
  if (filter.maxMs !== undefined) add('ms <= ?', filter.maxMs)
  return { sql: clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`, params }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

/**
 * API request timings held in SQLite for the retention window, so they
 * survive restarts. Aggregates cover only the newest ANALYSIS_LIMIT matching
 * samples: snapshots are polled and run on the main thread, so looking further
 * back means narrowing the time range.
 */
export class RequestTimings {
  private readonly db: Database
  private readonly lags: number[] = []
  private lastPruneAt = 0

  /** `path` is a SQLite file; `:memory:` keeps samples only for this process. */
  constructor(
    path = ':memory:',
    private readonly retentionMs = RETENTION_MS,
  ) {
    this.db = openTimingsDatabase(path)
  }

  record(sample: Omit<RequestSample, 'id'>): void {
    this.db
      .query(
        `insert into requests (at, method, route, path, query, source, referer, user_agent, status, ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sample.at,
        sample.method,
        sample.route,
        sample.path,
        sample.query,
        sample.source,
        sample.referer,
        sample.userAgent,
        sample.status,
        sample.ms,
      )
    if (sample.at - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.db.query('delete from requests where at < ?').run(sample.at - this.retentionMs)
      this.lastPruneAt = sample.at
    }
  }

  close(): void {
    this.db.close()
  }

  /**
   * Samples how late a fixed timer fires. Synchronous work on the main thread
   * (Bun.spawnSync, big JSON encodes) stalls every request at once, which
   * per-route timings alone cannot tell apart from a slow handler.
   */
  watchEventLoop(): () => void {
    let expected = performance.now() + LAG_INTERVAL_MS
    const timer = setInterval(() => {
      const now = performance.now()
      this.lags.push(Math.max(0, now - expected))
      if (this.lags.length > LAG_WINDOW) this.lags.shift()
      expected = now + LAG_INTERVAL_MS
    }, LAG_INTERVAL_MS)
    return () => clearInterval(timer)
  }

  snapshot(filter: TimingFilter = {}): TimingSnapshot {
    const where = whereClause(filter)
    const samples = (
      this.db
        .query(`select * from requests ${where.sql} order by id desc limit ${ANALYSIS_LIMIT}`)
        .all(...where.params) as Row[]
    ).map(toSample)
    const total = (this.db.query('select count(*) as n from requests').get() as { n: number }).n
    const matched =
      where.sql === ''
        ? total
        : (
            this.db
              .query(`select count(*) as n from requests ${where.sql}`)
              .get(...where.params) as {
              n: number
            }
          ).n
    const routes = groupBy(samples, (s) => `${s.method} ${s.route}`).map((group): RouteTiming => {
      const durations = group.map((s) => s.ms).sort((a, b) => a - b)
      const totalMs = durations.reduce((sum, ms) => sum + ms, 0)
      const first = group[0] as RequestSample
      return {
        method: first.method,
        route: first.route,
        count: group.length,
        errors: group.filter((s) => s.status >= 500).length,
        totalMs,
        avgMs: totalMs / group.length,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        maxMs: durations.at(-1) ?? 0,
        lastAt: Math.max(...group.map((s) => s.at)),
      }
    })
    routes.sort((a, b) => b.totalMs - a.totalMs)
    const sources = groupBy(samples, (s) => s.source).map((group): SourceTiming => {
      const totalMs = group.reduce((sum, s) => sum + s.ms, 0)
      return {
        source: (group[0] as RequestSample).source,
        count: group.length,
        errors: group.filter((s) => s.status >= 500).length,
        totalMs,
        avgMs: totalMs / group.length,
        lastAt: Math.max(...group.map((s) => s.at)),
      }
    })
    sources.sort((a, b) => b.totalMs - a.totalMs)
    const lastLag = this.lags.at(-1)
    const oldest = this.db.query('select min(at) as at from requests').get() as {
      at: number | null
    }
    return {
      windowStart: oldest.at,
      total,
      matched,
      analysed: samples.length,
      retentionMs: this.retentionMs,
      routes,
      sources,
      slowest: [...samples].sort((a, b) => b.ms - a.ms).slice(0, LIST_LIMIT),
      recent: samples.slice(0, LIST_LIMIT),
      eventLoop:
        lastLag === undefined ? null : { lagMs: lastLag, maxLagMs: Math.max(...this.lags) },
    }
  }
}
