import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  likeAny,
  openDiagnosticsDatabase,
  percentile,
  TIMINGS_RETENTION_MS,
} from './request-timings.ts'

/** What the operator did: a click, a key press, a picker change, or typing into a field. */
export type InteractionKind = 'click' | 'key' | 'change' | 'input'

/**
 * `settled`: the UI painted and every request it started finished.
 * `superseded`: the operator acted again first. `timeout`: still busy at the cap.
 */
export type InteractionOutcome = 'settled' | 'superseded' | 'timeout'

/** One fetch the dashboard started while the interaction was open. */
export type InteractionRequest = {
  method: string
  /** Path and query, without the origin. */
  path: string
  /** Offset from the input, in ms. */
  startMs: number
  /** Null while it was still in flight when the interaction ended. */
  ms: number | null
  /** 0 on a network error; null while still in flight. */
  status: number | null
}

export type InteractionSample = {
  /** Row id in the timings database; stable across snapshots and restarts. */
  id: number
  /** Wall clock of the input. */
  at: number
  kind: InteractionKind
  /** The element or key acted on, e.g. `button "Close"` or `Escape on dialog`. */
  action: string
  /** Title of the dialog the action happened in, if any. */
  context: string | null
  /** The dashboard route pattern, so pages for different tasks aggregate together. */
  route: string
  path: string
  /** Input to the first frame painted after it; null if superseded before that frame. */
  paintMs: number | null
  /** Input to settled, superseded or timed out. */
  ms: number
  outcome: InteractionOutcome
  requests: InteractionRequest[]
}

export type ActionTiming = {
  kind: InteractionKind
  action: string
  context: string | null
  route: string
  count: number
  /** Ended without settling: superseded or timed out. */
  unsettled: number
  p50PaintMs: number
  p95PaintMs: number
  /** Settled interactions only. */
  p50Ms: number
  p95Ms: number
  maxMs: number
  totalMs: number
  lastAt: number
}

/** Every set field must match; bounds are inclusive. */
export type InteractionFilter = {
  /** Substring of the action or its dialog, case-insensitive for ASCII. */
  action?: string | undefined
  /** Substring of the route pattern or concrete path. */
  page?: string | undefined
  kind?: InteractionKind | undefined
  from?: number | undefined
  to?: number | undefined
  minMs?: number | undefined
  maxMs?: number | undefined
}

export type InteractionSnapshot = {
  /** Timestamp of the oldest sample still held, or null before the first interaction. */
  windowStart: number | null
  total: number
  matched: number
  /** The newest matching samples, at most ANALYSIS_LIMIT; everything below is computed from these. */
  analysed: number
  retentionMs: number
  p50PaintMs: number
  p95PaintMs: number
  p50Ms: number
  p95Ms: number
  /** Heaviest first by total settled time. */
  actions: ActionTiming[]
  slowest: InteractionSample[]
  /** Newest first. */
  recent: InteractionSample[]
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000
const ANALYSIS_LIMIT = 5000
const LIST_LIMIT = 50

type Row = {
  id: number
  at: number
  kind: InteractionKind
  action: string
  context: string | null
  route: string
  path: string
  paint_ms: number | null
  ms: number
  outcome: InteractionOutcome
  requests: string
}

const toSample = (r: Row): InteractionSample => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  action: r.action,
  context: r.context,
  route: r.route,
  path: r.path,
  paintMs: r.paint_ms,
  ms: r.ms,
  outcome: r.outcome,
  requests: JSON.parse(r.requests) as InteractionRequest[],
})

function whereClause(filter: InteractionFilter): { sql: string; params: SQLQueryBindings[] } {
  const clauses: string[] = []
  const params: SQLQueryBindings[] = []
  const add = (clause: string, ...values: SQLQueryBindings[]) => {
    clauses.push(clause)
    params.push(...values)
  }
  if (filter.action) {
    const like = likeAny(filter.action)
    add(`(action like ? escape '\\' or context like ? escape '\\')`, like, like)
  }
  if (filter.page) {
    const like = likeAny(filter.page)
    add(`(route like ? escape '\\' or path like ? escape '\\')`, like, like)
  }
  if (filter.kind !== undefined) add('kind = ?', filter.kind)
  if (filter.from !== undefined) add('at >= ?', filter.from)
  if (filter.to !== undefined) add('at <= ?', filter.to)
  if (filter.minMs !== undefined) add('ms >= ?', filter.minMs)
  if (filter.maxMs !== undefined) add('ms <= ?', filter.maxMs)
  return { sql: clauses.length === 0 ? '' : `where ${clauses.join(' and ')}`, params }
}

const sortedNumbers = (values: (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null).sort((a, b) => a - b)

/**
 * Dashboard interaction timings reported by the browser, held next to the
 * request timings in the diagnostics database for the same retention window.
 */
export class InteractionTimings {
  private readonly db: Database
  private lastPruneAt = 0

  /** `path` is a SQLite file; `:memory:` keeps samples only for this process. */
  constructor(
    path = ':memory:',
    private readonly retentionMs = TIMINGS_RETENTION_MS,
  ) {
    this.db = openDiagnosticsDatabase(path)
    this.db.exec(`
      create table if not exists interactions (
        id       integer primary key autoincrement,
        at       integer not null,
        kind     text not null,
        action   text not null,
        context  text,
        route    text not null,
        path     text not null,
        paint_ms real,
        ms       real not null,
        outcome  text not null,
        requests text not null
      );
      create index if not exists interactions_at_idx on interactions (at);
    `)
  }

  record(samples: Omit<InteractionSample, 'id'>[]): void {
    const insert = this.db.query(
      `insert into interactions (at, kind, action, context, route, path, paint_ms, ms, outcome, requests)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.db.transaction(() => {
      for (const s of samples) {
        insert.run(
          s.at,
          s.kind,
          s.action,
          s.context,
          s.route,
          s.path,
          s.paintMs,
          s.ms,
          s.outcome,
          JSON.stringify(s.requests),
        )
      }
    })()
    const now = Date.now()
    if (now - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.db.query('delete from interactions where at < ?').run(now - this.retentionMs)
      this.lastPruneAt = now
    }
  }

  close(): void {
    this.db.close()
  }

  snapshot(filter: InteractionFilter = {}): InteractionSnapshot {
    const where = whereClause(filter)
    const samples = (
      this.db
        .query(`select * from interactions ${where.sql} order by id desc limit ${ANALYSIS_LIMIT}`)
        .all(...where.params) as Row[]
    ).map(toSample)
    const count = (sql: string, params: SQLQueryBindings[]) =>
      (
        this.db.query(`select count(*) as n from interactions ${sql}`).get(...params) as {
          n: number
        }
      ).n
    const total = count('', [])
    const matched = where.sql === '' ? total : count(where.sql, where.params)
    const groups = new Map<string, InteractionSample[]>()
    for (const s of samples) {
      const key = JSON.stringify([s.kind, s.action, s.context, s.route])
      const group = groups.get(key)
      if (group === undefined) groups.set(key, [s])
      else group.push(s)
    }
    const actions = [...groups.values()].map((group): ActionTiming => {
      const first = group[0] as InteractionSample
      const paints = sortedNumbers(group.map((s) => s.paintMs))
      const settled = sortedNumbers(group.map((s) => (s.outcome === 'settled' ? s.ms : null)))
      return {
        kind: first.kind,
        action: first.action,
        context: first.context,
        route: first.route,
        count: group.length,
        unsettled: group.length - settled.length,
        p50PaintMs: percentile(paints, 50),
        p95PaintMs: percentile(paints, 95),
        p50Ms: percentile(settled, 50),
        p95Ms: percentile(settled, 95),
        maxMs: settled.at(-1) ?? 0,
        totalMs: settled.reduce((sum, ms) => sum + ms, 0),
        lastAt: Math.max(...group.map((s) => s.at)),
      }
    })
    actions.sort((a, b) => b.totalMs - a.totalMs)
    const paints = sortedNumbers(samples.map((s) => s.paintMs))
    const settled = sortedNumbers(samples.map((s) => (s.outcome === 'settled' ? s.ms : null)))
    const oldest = this.db.query('select min(at) as at from interactions').get() as {
      at: number | null
    }
    return {
      windowStart: oldest.at,
      total,
      matched,
      analysed: samples.length,
      retentionMs: this.retentionMs,
      p50PaintMs: percentile(paints, 50),
      p95PaintMs: percentile(paints, 95),
      p50Ms: percentile(settled, 50),
      p95Ms: percentile(settled, 95),
      actions,
      slowest: [...samples].sort((a, b) => b.ms - a.ms).slice(0, LIST_LIMIT),
      recent: samples.slice(0, LIST_LIMIT),
    }
  }
}
