import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseRepo } from './diagnose.ts'
import type { RegistryEntry } from './registry.ts'

let dir: string
let repo: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-diag-'))
  repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const entry = (): RegistryEntry => ({ key: 'repo', name: 'repo', path: repo })

describe('diagnoseRepo', () => {
  test('reports a healthy repo with defaults', async () => {
    const checks = await diagnoseRepo(entry())
    const d = (name: string) => checks.find((c) => c.name === name)
    expect(d('git root')?.ok).toBe(true)
    expect(d('config')?.ok).toBe(true)
    expect(d('tracker beads')).toBeDefined()
    expect(d('forge github')).toBeDefined()
    expect(d('worktree root')?.ok).toBe(true)
    expect(d('checks')?.ok).toBe(false) // none configured
  })

  test('fails loudly when the path is not a git root', async () => {
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    const checks = await diagnoseRepo({ ...entry(), path: plain })
    expect(checks[0]).toMatchObject({ name: 'git root', ok: false })
  })

  test('reflects configured checks and a custom worktree root', async () => {
    writeFileSync(join(repo, 'config.toml'), '')
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[checks]\ncommands = ["just check"]\n\n[repo]\nworktreeRoot = "~/amagi-wt"\n',
    )
    const checks = await diagnoseRepo(entry())
    const d = (name: string) => checks.find((c) => c.name === name)
    expect(d('checks')?.ok).toBe(true)
    expect(d('worktree root')?.detail).toContain('amagi-wt')
  })
})
