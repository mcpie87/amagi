import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tracker } from './drivers/types.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'
import { Workspaces } from './workspace.ts'

const dir = mkdtempSync(join(tmpdir(), 'amagi-workspace-'))

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('live forge exposes the configured driver file upload API', () => {
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.amagi'), { recursive: true })
  writeFileSync(
    join(repo, '.amagi', 'config.toml'),
    '[forge]\nkind = "gitlab"\n\n[checks]\ncommands = []\n',
  )
  const registry = join(dir, 'registry.json')
  writeFileSync(
    registry,
    JSON.stringify([{ key: 'repo', path: repo, name: 'repo', workers: false, watchers: false }]),
  )
  const workspaces = new Workspaces({
    registryPath: registry,
    storeFor: () => new Store(openDatabase(':memory:')),
    trackerFor: () => ({}) as Tracker,
  })

  expect(workspaces.get('repo')?.forge?.uploadFile).toBeFunction()
  workspaces.close()
})
