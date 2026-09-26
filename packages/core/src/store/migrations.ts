import type { Database } from 'bun:sqlite'

/**
 * Inlined rather than read from .sql files on disk: `bun build --compile`
 * produces a single binary with no adjacent files to read. Never edit an
 * applied migration: existing databases keep whatever it created.
 */
export type Migration = { name: string } & ({ sql: string } | { apply: (db: Database) => void })

const hasColumn = (db: Database, table: string, column: string): boolean =>
  (db.query(`pragma table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column,
  )

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001_init',
    sql: `
      create table events (
        seq     integer primary key autoincrement,
        ts      integer not null,
        task_id text,
        type    text not null,
        body    text not null
      );
      create index events_task_idx on events (task_id, seq);
      create index events_type_idx on events (type, seq);

      create table tasks (
        id           text primary key,
        title        text not null,
        tracker      text not null,
        state        text not null,
        branch       text,
        worktree     text,
        session_id   text,
        pr_url       text,
        pr_number    integer,
        last_error   text,
        created_at   integer not null,
        updated_at   integer not null
      );
      create index tasks_state_idx on tasks (state, updated_at);

      create table questions (
        id           text primary key,
        task_id      text not null,
        question     text not null,
        options      text not null,
        gate_ref     text,
        answer       text,
        answered_via text,
        asked_at     integer not null,
        resolved_at  integer
      );
      create index questions_open_idx on questions (task_id, resolved_at);
    `,
  },
  {
    name: '002_task_token',
    sql: `
      alter table tasks add column task_token text;
    `,
  },
  {
    name: '003_retry_count',
    sql: `
      alter table tasks add column retry_count integer not null default 0;
    `,
  },
  {
    name: '004_last_commit_checks',
    sql: `
      alter table tasks add column last_commit_sha text;
      alter table tasks add column last_commit_subject text;
      alter table tasks add column checks text;
      alter table tasks add column checks_ok integer;
    `,
  },
  {
    name: '005_status_reason',
    sql: `
      alter table tasks add column status_reason text;
    `,
  },
  {
    name: '006_last_heartbeat_at',
    sql: `
      alter table tasks add column last_heartbeat_at integer;
    `,
  },
  {
    name: '007_retry_at',
    sql: `
      alter table tasks add column retry_at integer;
    `,
  },
  {
    name: '007_pr_merge_status',
    sql: `
      alter table tasks add column pr_merge_status text;
    `,
  },
  {
    name: '008_attempt',
    sql: `
      alter table tasks add column attempt integer not null default 1;
    `,
  },
  {
    name: '009_event_timestamp_index',
    sql: `create index events_ts_idx on events (ts, seq);`,
  },
  {
    name: '010_review_projection',
    apply: (db) => {
      // Databases created before review_round was dropped from 001_init still
      // carry it, holding counts from the removed reviewer loop.
      if (hasColumn(db, 'tasks', 'review_round')) db.exec('update tasks set review_round = 0')
      else db.exec('alter table tasks add column review_round integer not null default 0')
      db.exec(`
        alter table tasks add column review_findings text;
        alter table tasks add column review_stop_reason text;
      `)
    },
  },
]
