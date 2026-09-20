import type { Database } from 'bun:sqlite'
import { canTransition, type EventBody, type StoredEvent, type TaskState } from '../events.ts'
import { openDatabase } from './db.ts'

export type TaskRow = {
  id: string
  title: string
  tracker: string
  state: TaskState
  branch: string | null
  worktree: string | null
  sessionId: string | null
  prUrl: string | null
  prNumber: number | null
  reviewRound: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export type QuestionRow = {
  id: string
  taskId: string
  question: string
  options: string[]
  gateRef: string | null
  answer: string | null
  answeredVia: string | null
  askedAt: number
  resolvedAt: number | null
}

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

const toTask = (r: RawTask): TaskRow => ({
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
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toQuestion = (r: RawQuestion): QuestionRow => ({
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

export class InvalidTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`task ${taskId}: illegal transition ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
  }
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
    const set = (col: string, value: unknown) =>
      this.db
        .query(`update tasks set ${col} = ?, updated_at = ? where id = ?`)
        .run(value as never, ts, taskId)

    switch (body.type) {
      case 'task.claimed':
        this.db
          .query(
            `insert into tasks (id, title, tracker, state, created_at, updated_at)
             values (?, ?, ?, 'claimed', ?, ?)
             on conflict(id) do update set title = excluded.title, updated_at = excluded.updated_at`,
          )
          .run(taskId, body.title, body.tracker, ts, ts)
        break

      case 'task.state': {
        const current = this.task(taskId)
        if (current && !canTransition(current.state, body.to)) {
          throw new InvalidTransitionError(taskId, current.state, body.to)
        }
        set('state', body.to)
        if (body.to === 'reviewing') {
          this.db
            .query('update tasks set review_round = review_round + 1, updated_at = ? where id = ?')
            .run(ts, taskId)
        }
        break
      }

      case 'worktree.created':
        this.db
          .query('update tasks set worktree = ?, branch = ?, updated_at = ? where id = ?')
          .run(body.path, body.branch, ts, taskId)
        break

      case 'worktree.removed':
        set('worktree', null)
        break

      case 'agent.exited':
        if (body.sessionId !== null) set('session_id', body.sessionId)
        break

      case 'pr.created':
        this.db
          .query('update tasks set pr_url = ?, pr_number = ?, updated_at = ? where id = ?')
          .run(body.url, body.number, ts, taskId)
        break

      case 'question.asked':
        this.db
          .query(
            `insert into questions (id, task_id, question, options, gate_ref, asked_at)
             values (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            body.questionId,
            taskId,
            body.question,
            JSON.stringify(body.options),
            body.gateRef,
            ts,
          )
        break

      case 'question.answered':
        this.db
          .query('update questions set answer = ?, answered_via = ?, resolved_at = ? where id = ?')
          .run(body.answer, body.via, ts, body.questionId)
        break

      case 'question.timedout':
        this.db.query('update questions set resolved_at = ? where id = ?').run(ts, body.questionId)
        break

      case 'error':
        set('last_error', body.message)
        break

      default:
        break
    }
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
