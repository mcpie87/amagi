import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type { CheckResult, EventBody, MergeStatus, StoredEvent, TaskState } from '../events.ts'
import {
  emptyProjection,
  type ProjectedQuestion,
  type ProjectedTask,
  type Projection,
  project,
} from '../project.ts'

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
  pr_merge_status: string | null
  status_reason: string | null
  last_error: string | null
  retry_count: number
  retry_at: number | null
  last_commit_sha: string | null
  last_commit_subject: string | null
  checks: string | null
  checks_ok: number | null
  created_at: number
  updated_at: number
  last_heartbeat_at: number | null
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
  prMergeStatus: r.pr_merge_status as MergeStatus | null,
  statusReason: r.status_reason,
  lastError: r.last_error,
  retryCount: r.retry_count,
  retryAt: r.retry_at,
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

type Row = Record<string, SQLQueryBindings>

/** The projected row as SQL values keyed by column name: one map between the
 *  reducer shape and the schema, in place of a hand-kept column diff. Columns
 *  the projection doesn't carry (task_token, last_heartbeat_at) are omitted so
 *  an upsert leaves them untouched. */
const taskRow = (t: ProjectedTask): Row => ({
  id: t.id,
  title: t.title,
  tracker: t.tracker,
  state: t.state,
  branch: t.branch,
  worktree: t.worktree,
  session_id: t.sessionId,
  pr_url: t.prUrl,
  pr_number: t.prNumber,
  pr_merge_status: t.prMergeStatus,
  status_reason: t.statusReason,
  last_error: t.lastError,
  retry_count: t.retryCount,
  retry_at: t.retryAt,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
  last_commit_sha: t.lastCommit?.sha ?? null,
  last_commit_subject: t.lastCommit?.subject ?? null,
  checks: t.checks === null ? null : JSON.stringify(t.checks),
  checks_ok: t.checksOk === null ? null : t.checksOk ? 1 : 0,
})

const questionRow = (q: ProjectedQuestion): Row => ({
  id: q.id,
  task_id: q.taskId,
  question: q.question,
  options: JSON.stringify(q.options),
  gate_ref: q.gateRef,
  answer: q.answer,
  answered_via: q.answeredVia,
  asked_at: q.askedAt,
  resolved_at: q.resolvedAt,
})

/** Inserts on first sight, else rewrites the projected columns. The store is a
 *  local single-writer SQLite file, so an upsert beats a column diff. */
function upsert(db: Database, table: string, key: string, row: Row): void {
  const cols = Object.keys(row)
  const set = cols
    .filter((c) => c !== key)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')
  db.query(
    `insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})
     on conflict(${key}) do update set ${set}`,
  ).run(...Object.values(row))
}

export type Listener = (event: StoredEvent) => void

/**
 * Event log is the source of truth; `tasks` and `questions` are projections
 * maintained in the same transaction as the append. Anything derived must go
 * through `apply` so a rebuild reproduces it exactly.
 */
export class Store {
  private readonly listeners = new Set<Listener>()

  constructor(readonly db: Database) {}

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
    // The same pure reducer the clients fold events through; the server just
    // persists its output wholesale.
    const event = { seq: 0, ts, taskId, ...body } as StoredEvent
    const before = this.projectionFor(event)
    const after = project(before, event)

    if (event.taskId !== null) {
      const task = after.tasks[event.taskId]
      if (task) upsert(this.db, 'tasks', 'id', taskRow(task))
    }
    if (
      event.type === 'question.asked' ||
      event.type === 'question.answered' ||
      event.type === 'question.timedout'
    ) {
      const question = after.questions[event.questionId]
      if (question) upsert(this.db, 'questions', 'id', questionRow(question))
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

  /**
   * A column rather than an event: heartbeats land on every lease tick, so
   * folding them into the event log would drown the streams in noise. The
   * stall watcher reads this timestamp to tell a live worker from a dead one.
   */
  heartbeat(taskId: string): void {
    this.db.query('update tasks set last_heartbeat_at = ? where id = ?').run(Date.now(), taskId)
  }

  /**
   * Tasks in the given states whose last activity (worker heartbeat, falling
   * back to the last event) predates `beforeMs`. The stall watcher's scan set.
   */
  stalledTasks(
    states: readonly TaskState[],
    beforeMs: number,
  ): { id: string; state: TaskState; updatedAt: number; lastHeartbeatAt: number | null }[] {
    if (states.length === 0) return []
    const holes = states.map(() => '?').join(', ')
    const rows = this.db
      .query(
        `select id, state, updated_at, last_heartbeat_at from tasks
         where state in (${holes}) and coalesce(last_heartbeat_at, updated_at) < ?`,
      )
      .all(...states, beforeMs) as {
      id: string
      state: string
      updated_at: number
      last_heartbeat_at: number | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      state: r.state as TaskState,
      updatedAt: r.updated_at,
      lastHeartbeatAt: r.last_heartbeat_at,
    }))
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

  /**
   * The most recent events for one task, oldest first, for windowed analysis
   * (e.g. the doom-loop guard). Reads from the tail so a long-lived task's
   * early history is never re-read.
   */
  recentEvents(taskId: string, limit: number): StoredEvent[] {
    const rows = this.db
      .query('select * from events where task_id = ? order by seq desc limit ?')
      .all(taskId, limit) as { seq: number; ts: number; task_id: string | null; body: string }[]
    return rows.reverse().map((r) => ({
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
   * The most recent implement-run start for a task: the model/effort an
   * operator-facing surface can show without folding the whole event log.
   * Chat runs are skipped so chatting with a finished worker does not
   * overwrite the agent that did the work.
   */
  currentAgent(taskId: string): { model: string | null; effort: string | null } | null {
    const rows = this.db
      .query(
        `select body from events where task_id = ? and type = 'agent.started'
         order by seq desc limit 20`,
      )
      .all(taskId) as { body: string }[]
    for (const row of rows) {
      const body = JSON.parse(row.body) as {
        role: string
        model: string | null
        effort: string | null
      }
      if (body.role !== 'chat') {
        return { model: body.model ?? null, effort: body.effort ?? null }
      }
    }
    return null
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

  close(): void {
    this.db.close()
  }
}
