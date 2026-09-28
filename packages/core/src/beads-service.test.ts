import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BeadsService, embeddedDoltVersion } from './beads-service.ts'
import { BeadsTracker } from './drivers/tracker/beads.ts'
import type { Exec } from './exec.ts'

function counting(stdout = '[]') {
  const calls: (readonly string[])[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    return { exitCode: 0, stdout, stderr: '' }
  }
  return { tracker: new BeadsTracker({ cwd: '/repo', exec }), calls }
}

describe('BeadsService', () => {
  test('reuses a read until the store version changes', async () => {
    const { tracker, calls } = counting()
    let version = 'v1'
    const service = new BeadsService(tracker, '/repo', () => version)
    await service.list()
    await service.list()
    expect(calls).toHaveLength(1)
    version = 'v2'
    await service.list()
    expect(calls).toHaveLength(2)
  })

  test('concurrent identical reads share one bd process', async () => {
    const { tracker, calls } = counting()
    const service = new BeadsService(tracker, '/repo', () => 'v1')
    await Promise.all([service.getIssue('a'), service.getIssue('a'), service.getIssue('b')])
    expect(calls).toHaveLength(2)
  })

  test('an unknown store version reads through every time', async () => {
    const { tracker, calls } = counting()
    const service = new BeadsService(tracker, '/repo', () => null)
    await service.list()
    await service.list()
    expect(calls).toHaveLength(2)
  })

  test('a failed read is retried rather than cached', async () => {
    let fail = true
    const exec: Exec = async () =>
      fail
        ? { exitCode: 1, stdout: '', stderr: 'locked' }
        : { exitCode: 0, stdout: '[]', stderr: '' }
    const service = new BeadsService(new BeadsTracker({ cwd: '/repo', exec }), '/repo', () => 'v1')
    await expect(service.list()).rejects.toThrow()
    fail = false
    expect(await service.list()).toEqual([])
  })
})

describe('BeadsService.gc', () => {
  test('skips bd when there is no embedded store', async () => {
    const { tracker, calls } = counting()
    expect(await new BeadsService(tracker, '/repo', () => null).gc()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('records a failed collection instead of throwing', async () => {
    const exec: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'disk full' })
    const service = new BeadsService(new BeadsTracker({ cwd: '/repo', exec }), '/repo', () => 'v1')
    const run = await service.gc(() => 42)
    expect(run).toMatchObject({ at: 42, ok: false })
    expect(service.lastGc).toBe(run)
  })
})

describe('embeddedDoltVersion', () => {
  function repo(meta: object): string {
    const root = mkdtempSync(join(tmpdir(), 'amagi-beads-'))
    mkdirSync(join(root, '.beads', 'embeddeddolt', 'am', '.dolt', 'noms'), { recursive: true })
    writeFileSync(join(root, '.beads', 'metadata.json'), JSON.stringify(meta))
    writeFileSync(join(root, '.beads', 'embeddeddolt', 'am', '.dolt', 'noms', 'manifest'), 'root-1')
    return root
  }

  test('is the manifest of the embedded database', () => {
    expect(embeddedDoltVersion(repo({ dolt_mode: 'embedded', dolt_database: 'am' }))).toBe('root-1')
  })

  test('is null for a server-mode store or a repo without beads', () => {
    expect(embeddedDoltVersion(repo({ dolt_mode: 'server', dolt_database: 'am' }))).toBeNull()
    expect(embeddedDoltVersion(mkdtempSync(join(tmpdir(), 'amagi-beads-')))).toBeNull()
  })
})
