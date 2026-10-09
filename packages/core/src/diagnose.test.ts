import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diagnoseRepo } from './diagnose.ts'
import type { RegistryEntry } from './registry.ts'

let dir: string
let repo: string
const savedState = process.env.XDG_STATE_HOME
const savedConfig = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-diag-'))
  repo = join(dir, 'repo')
  mkdirSync(repo, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
  mkdirSync(join(repo, '.amagi'), { recursive: true })
  writeFileSync(
    join(repo, '.amagi', 'config.toml'),
    '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
  )
  process.env.XDG_STATE_HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, 'config')
})

afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedConfig
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
  test('reports a healthy repo with declared checks', async () => {
    const checks = await diagnoseRepo(entry())
    const d = (name: string) => checks.find((c) => c.name === name)
    expect(d('git root')?.ok).toBe(true)
    expect(d('config')?.ok).toBe(true)
    expect(d('tracker beads')).toBeDefined()
    expect(d('forge github')).toBeDefined()
    expect(d('worktree root')?.ok).toBe(true)
    // All three project checks must be declared for the repo to be ready.
    expect(d('checks')?.ok).toBe(true)
  })

  test('reports missing project checks as a config error', async () => {
    writeFileSync(join(repo, '.amagi', 'config.toml'), '[repo]\nbaseBranch = "main"\n')
    const config = (await diagnoseRepo(entry())).find((check) => check.name === 'config')
    expect(config?.ok).toBe(false)
    expect(config?.detail).toContain('must declare non-empty format, lint, test')
  })

  test('flags a forge remote that points at another forge', async () => {
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:me/app.git'], { cwd: repo })
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[forge]\nkind = "gitlab"\nremote = "origin"\n\n' +
        '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
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
      '[checks]\nformat = "just fmt"\nlint = "just lint"\ntest = "just test"\n' +
        'commands = ["just check"]\n\n[repo]\nworktreeRoot = "~/amagi-wt"\n',
    )
    const checks = await diagnoseRepo(entry())
    const d = (name: string) => checks.find((c) => c.name === name)
    expect(d('checks')?.ok).toBe(true)
    expect(d('worktree root')?.detail).toContain('amagi-wt')
  })

  test('flags a harness bin amagi cannot spawn, once per binary', async () => {
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[harness.implement]\nkind = "claude"\nbin = "amagi-no-such-harness"\n\n' +
        '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
    )
    const harness = (await diagnoseRepo(entry())).filter((c) => c.name.startsWith('harness '))
    expect(harness).toEqual([
      {
        name: 'harness amagi-no-such-harness',
        ok: false,
        detail:
          'amagi-no-such-harness not on PATH (used by harness.implement, mention watcher, prConflict watcher); shell aliases and functions are not visible, point bin at an executable',
      },
    ])
  })

  test('accepts a harness bin given as a path to an executable', async () => {
    const wrapper = join(dir, 'claude-wrapper')
    writeFileSync(wrapper, '#!/bin/sh\nexec claude "$@"\n')
    chmodSync(wrapper, 0o755)
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      `[harness.implement]\nkind = "claude"\nbin = "${wrapper}"\n\n` +
        '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
    )
    const check = (await diagnoseRepo(entry())).find((c) => c.name === `harness ${wrapper}`)
    expect(check).toEqual({ name: `harness ${wrapper}`, ok: true, detail: wrapper })
  })
})
