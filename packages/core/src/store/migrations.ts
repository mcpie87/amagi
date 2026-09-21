/**
 * Inlined rather than read from .sql files on disk: `bun build --compile`
 * produces a single binary with no adjacent files to read.
 */
export const MIGRATIONS: readonly { name: string; sql: string }[] = [
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
        review_round integer not null default 0,
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
]
