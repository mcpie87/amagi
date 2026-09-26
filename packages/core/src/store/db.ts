import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations.ts'

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma foreign_keys = ON')
  db.exec('pragma busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.exec(
    'create table if not exists schema_migrations (name text primary key, applied_at integer not null)',
  )
  const applied = new Set(
    (db.query('select name from schema_migrations').all() as { name: string }[]).map((r) => r.name),
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue
    db.transaction(() => {
      if ('sql' in m) db.exec(m.sql)
      else m.apply(db)
      db.query('insert into schema_migrations (name, applied_at) values (?, ?)').run(
        m.name,
        Date.now(),
      )
    })()
  }
}
