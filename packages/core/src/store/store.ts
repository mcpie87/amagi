import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { CheckResult, EventBody, StoredEvent, TaskState } from '../events.ts'
import {
  emptyProjection,
  type ProjectedQuestion,
  type ProjectedTask,
  type Projection,
  project,
} from '../project.ts'
import { openDatabase } from './db.ts'

export { InvalidTransitionError } from '../project.ts'
export type { ProjectedQuestion, ProjectedTask, Projection }

/** The SQL projection rows are the very same shape the shared reducer produces. */
export type TaskRow = ProjectedTask
export type QuestionRow = ProjectedQuestion

type RawTask = {
  id: string
  title: string
  tracker: string
  state: string
  branch: string | null
  worktree: string | null
  session_id: string | null
  pr_url: string | null
  pr_number: number | null
  review_round: number
  last_error: string | null
  retry_count: number
  last_commit_sha: string | null
  last_commit_subject: string | null
  checks: string | null
  checks_ok: number | null
  created_at: number
  updated_at: number
}

type RawQuestion = {
  id: string
  task_id: string
  question: string
  options: string
  gate_ref: string | null
  answer: string | null
  answered_via: string | null
  asked_at: number
  resolved_at: number | null
}

const toTask = (r: RawTask): ProjectedTask => ({
  id: r.id,
  title: r.title,
  tracker: r.tracker,
  state: r.state as TaskState,
  branch: r.branch,
  worktree: r.worktree,
  sessionId: r.session_id,
  prUrl: r.pr_url,
  prNumber: r.pr_number,
  reviewRound: r.review_round,
  lastError: r.last_error,
  retryCount: r.retry_count,
  lastCommit:
    r.last_commit_sha === null
      ? null
      : { sha: r.last_commit_sha, subject: r.last_commit_subject ?? '' },
  checks: r.checks === null ? null : (JSON.parse(r.checks) as CheckResult[]),
  checksOk: r.checks_ok === null ? null : r.checks_ok === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toQuestion = (r: RawQuestion): ProjectedQuestion => ({
  id: r.id,
  taskId: r.task_id,
  question: r.question,
  options: JSON.parse(r.options) as string[],
  gateRef: r.gate_ref,
  answer: r.answer,
  answeredVia: r.answered_via,
  askedAt: r.asked_at,
  resolvedAt: r.resolved_at,
})

type Column<T> = { col: string; from: (value: T) => SQLQueryBindings }

/** Every projected field maps to exactly one column, so SQL mirrors the reducer. */
const TASK_COLUMNS: Column<ProjectedTask>[] = [
  { col: 'id', from: (t) => t.id },
  { col: 'title', from: (t) => t.title },
  { col: 'tracker', from: (t) => t.tracker },
  { col: 'state', from: (t) => t.state },
  { col: 'branch', from: (t) => t.branch },
  { col: 'worktree', from: (t) => t.worktree },
  { col: 'session_id', from: (t) => t.sessionId },
  { col: 'pr_url', from: (t) => t.prUrl },
  { col: 'pr_number', from: (t) => t.prNumber },
  { col: 'review_round', from: (t) => t.reviewRound },
  { col: 'last_error', from: (t) => t.lastError },
  { col: 'retry_count', from: (t) => t.retryCount },
  { col: 'created_at', from: (t) => t.createdAt },
  { col: 'updated_at', from: (t) => t.updatedAt },
  { col: 'last_commit_sha', from: (t) => t.lastCommit?.sha ?? null },
  { col: 'last_commit_subject', from: (t) => t.lastCommit?.subject ?? null },
  { col: 'checks', from: (t) => (t.checks === null ? null : JSON.stringify(t.checks)) },
  { col: 'checks_ok', from: (t) => (t.checksOk === null ? null : t.checksOk ? 1 : 0) },
]

const QUESTION_COLUMNS: Column<ProjectedQuestion>[] = [
  { col: 'id', from: (q) => q.id },
  { col: 'task_id', from: (q) => q.taskId },
  { col: 'question', from: (q) => q.question },
  { col: 'options', from: (q) => JSON.stringify(q.options) },
  { col: 'gate_ref', from: (q) => q.gateRef },
  { col: 'answer', from: (q) => q.answer },
  { col: 'answered_via', from: (q) => q.answeredVia },
  { col: 'asked_at', from: (q) => q.askedAt },
  { col: 'resolved_at', from: (q) => q.resolvedAt },
]

/** Inserts on first sight, else updates only the columns the reducer changed. */
function writeDiff<T>(
  db: Database,
  table: string,
  columns: Column<T>[],
  before: T | undefined,
  after: T | undefined,
  key: string,
  keyValue: string,
): void {
  if (before === undefined && after !== undefined) {
    const cols = columns.map((c) => c.col)
    db.query(
      `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`,
    ).run(...columns.map((c) => c.from(after)))
    return
  }
  if (before === undefined || after === undefined) return
  const changes = columns.filter((c) => c.col !== key && !Object.is(c.from(before), c.from(after)))
  if (changes.length === 0) return
  db.query(
    `update ${table} set ${changes.map((c) => `${c.col} = ?`).join(', ')} where ${key} = ?`,
  ).run(...changes.map((c) => c.from(after)), keyValue)
}

export type Listener = (event: StoredEvent) => void

/**
 * Event log is the source of truth; `tasks` and `questions` are projections
 * maintained in the same transaction as the append. Anything derived must go
 * through `apply` so a rebuild reproduces it exactly.
 */
export class Store {
  private readonly listeners = new Set<Listener>()

  constructor(readonly db: Database = openDatabase()) {}

  append(taskId: string | null, body: EventBody): StoredEvent {
    let seq = 0
    const ts = Date.now()

    this.db.transaction(() => {
      const res = this.db
        .query('insert into events (ts, task_id, type, body) values (?, ?, ?, ?) returning seq')
        .get(ts, taskId, body.type, JSON.stringify(body)) as { seq: number }
      seq = res.seq
      this.apply(taskId, ts, body)
    })()

    const stored = { seq, ts, taskId, ...body } as StoredEvent
    for (const l of this.listeners) l(stored)
    return stored
  }

  private apply(taskId: string | null, ts: number, body: EventBody): void {
    if (taskId === null) return
    // The same pure reducer the clients fold events through; only the
    // persistence differs: the server diffs the projection to SQL.
    const event = { seq: 0, ts, taskId, ...body } as StoredEvent
    const before = this.projectionFor(event)
    const after = project(before, event)

    if (event.taskId !== null) {
      writeDiff(
        this.db,
        'tasks',
        TASK_COLUMNS,
        before.tasks[event.taskId],
        after.tasks[event.taskId],
        'id',
        event.taskId,
      )
    }
    if (
      event.type === 'question.asked' ||
      event.type === 'question.answered' ||
      event.type === 'question.timedout'
    ) {
      writeDiff(
        this.db,
        'questions',
        QUESTION_COLUMNS,
        before.questions[event.questionId],
        after.questions[event.questionId],
        'id',
        event.questionId,
      )
    }
  }

  /** Loads the rows the event may touch into a projection, from SQL. */
  private projectionFor(event: StoredEvent): Projection {
    const projection = emptyProjection()
    if (event.taskId !== null) {
      const row = this.db
        .query('select * from tasks where id = ?')
        .get(event.taskId) as RawTask | null
      if (row) projection.tasks[row.id] = toTask(row)
    }
    if (
      event.type === 'question.asked' ||
      event.type === 'question.answered' ||
      event.type === 'question.timedout'
    ) {
      const row = this.db
        .query('select * from questions where id = ?')
        .get(event.questionId) as RawQuestion | null
      if (row) projection.questions[row.id] = toQuestion(row)
    }
    return projection
  }

  task(id: string): TaskRow | null {
    const row = this.db.query('select * from tasks where id = ?').get(id) as RawTask | null
    return row ? toTask(row) : null
  }

  /**
   * `updated_at` is only millisecond resolution, so tasks touched in the same
   * tick need the rowid tie break or the queue view reshuffles between reads.
   */
  tasks(opts: { states?: readonly TaskState[]; limit?: number } = {}): TaskRow[] {
    const limit = opts.limit ?? 200
    const order = 'order by updated_at desc, rowid desc limit ?'
    if (opts.states?.length) {
      const holes = opts.states.map(() => '?').join(', ')
      const rows = this.db
        .query(`select * from tasks where state in (${holes}) ${order}`)
        .all(...opts.states, limit) as RawTask[]
      return rows.map(toTask)
    }
    const rows = this.db.query(`select * from tasks ${order}`).all(limit) as RawTask[]
    return rows.map(toTask)
  }

  events(opts: { taskId?: string; sinceSeq?: number; limit?: number } = {}): StoredEvent[] {
    const since = opts.sinceSeq ?? 0
    const limit = opts.limit ?? 500
    const rows = (
      opts.taskId
        ? this.db
            .query('select * from events where task_id = ? and seq > ? order by seq limit ?')
            .all(opts.taskId, since, limit)
        : this.db.query('select * from events where seq > ? order by seq limit ?').all(since, limit)
    ) as { seq: number; ts: number; task_id: string | null; body: string }[]

    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      taskId: r.task_id,
      ...(JSON.parse(r.body) as EventBody),
    }))
  }

  question(id: string): QuestionRow | null {
    const row = this.db.query('select * from questions where id = ?').get(id) as RawQuestion | null
    return row ? toQuestion(row) : null
  }

  /**
   * Lazily minted credential that binds an ask/answer to its task. A column
   * rather than an event so the secret never reaches the SSE stream; the cost
   * is that a manual rebuild mints a fresh one.
   */
  token(id: string): string {
    const row = this.db.query('select task_token from tasks where id = ?').get(id) as {
      task_token: string | null
    } | null
    if (row?.task_token) return row.task_token
    const token = crypto.randomUUID()
    this.db.query('update tasks set task_token = ? where id = ?').run(token, id)
    return token
  }

  openQuestions(taskId?: string): QuestionRow[] {
    const rows = (
      taskId
        ? this.db
            .query(
              'select * from questions where resolved_at is null and task_id = ? order by asked_at',
            )
            .all(taskId)
        : this.db.query('select * from questions where resolved_at is null order by asked_at').all()
    ) as RawQuestion[]
    return rows.map(toQuestion)
  }

  /** Questions still expecting an answer, including ones whose await poll timed out. */
  unansweredQuestions(taskId?: string): QuestionRow[] {
    const rows = (
      taskId
        ? this.db
            .query('select * from questions where answer is null and task_id = ? order by asked_at')
            .all(taskId)
        : this.db.query('select * from questions where answer is null order by asked_at').all()
    ) as RawQuestion[]
    return rows.map(toQuestion)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Long lived streams leak the store if they forget to unsubscribe. */
  get listenerCount(): number {
    return this.listeners.size
  }

  /** Drops the projections and folds the whole log back over them. */
  rebuild(): void {
    this.db.transaction(() => {
      this.db.exec('delete from tasks; delete from questions;')
      const rows = this.db
        .query('select seq, ts, task_id, body from events order by seq')
        .all() as {
        ts: number
        task_id: string | null
        body: string
      }[]
      for (const r of rows) this.apply(r.task_id, r.ts, JSON.parse(r.body) as EventBody)
    })()
  }

  close(): void {
    this.db.close()
  }
}
