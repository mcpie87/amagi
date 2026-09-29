import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseRepo } from './diagnose.ts'
import type { RegistryEntry } from './registry.ts'

let dir: string
let repo: string
const savedState = process.env.XDG_STATE_HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-diag-'))
  repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
  process.env.XDG_STATE_HOME = dir
})

afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(dir, { recursive: true, force: true })
})

const entry = (): RegistryEntry => ({
  key: 'repo',
  name: 'repo',
  path: repo,
  workers: true,
  watchers: true,
  gitIdentity: null,
})

describe('diagnoseRepo', () => {
  test('reports a healthy repo with defaults', async () => {
    const checks = await diagnoseRepo(entry())
    const d = (name: string) => checks.find((c) => c.name === name)
    expect(d('git root')?.ok).toBe(true)
    expect(d('config')?.ok).toBe(true)
    expect(d('tracker beads')).toBeDefined()
    expect(d('forge github')).toBeDefined()
    expect(d('worktree root')?.ok).toBe(true)
    // the mandatory format+lint gate is on by default
    expect(d('checks')?.ok).toBe(true)
  })

  test('flags a forge remote that points at another forge', async () => {
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:me/app.git'], { cwd: repo })
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[forge]\nkind = "gitlab"\nremote = "origin"\n',
    )
    const remote = (await diagnoseRepo(entry())).find((c) => c.name === 'forge remote')
    expect(remote).toMatchObject({
      ok: false,
      detail: 'origin points at github.com, not the gitlab forge at gitlab.com',
    })
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
