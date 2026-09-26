import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db.ts'
import { MIGRATIONS } from './migrations.ts'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

test('010 migrates a database whose 001_init still created review_round', () => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-db-'))
  const path = join(dir, 'legacy.db')
  const legacy = new Database(path, { create: true })
  legacy.exec('create table schema_migrations (name text primary key, applied_at integer not null)')
  for (const m of MIGRATIONS.slice(
    0,
    MIGRATIONS.findIndex((m) => m.name === '010_review_projection'),
  )) {
    if (!('sql' in m)) throw new Error(`${m.name} is not plain sql`)
    legacy.exec(m.sql)
    legacy.query('insert into schema_migrations values (?, 0)').run(m.name)
  }
  legacy.exec('alter table tasks add column review_round integer not null default 0')
  legacy.exec(
    "insert into tasks (id, title, tracker, state, created_at, updated_at, review_round) values ('bd-1', 't', 'beads', 'done', 0, 0, 3)",
  )
  legacy.close()

  const db = openDatabase(path)
  expect(db.query('select review_round, review_findings from tasks').get()).toEqual({
    review_round: 0,
    review_findings: null,
  })
  db.close()
})
