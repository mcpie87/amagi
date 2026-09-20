import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'

let home: string
let repo: string
const savedXdg = process.env.XDG_CONFIG_HOME

const writeGlobal = (toml: string) => {
  mkdirSync(join(home, 'amagi'), { recursive: true })
  writeFileSync(join(home, 'amagi', 'config.toml'), toml)
}

const writeRepo = (toml: string) => {
  mkdirSync(join(repo, '.amagi'), { recursive: true })
  writeFileSync(join(repo, '.amagi', 'config.toml'), toml)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amagi-cfg-'))
  repo = mkdtempSync(join(tmpdir(), 'amagi-repo-'))
  process.env.XDG_CONFIG_HOME = home
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

describe('loadConfig', () => {
  test('works with no files at all', () => {
    const { config, sources } = loadConfig(repo)
    expect(sources).toEqual([])
    expect(config.tracker.kind).toBe('beads')
    expect(config.forge.kind).toBe('github')
    expect(config.harness.implement.kind).toBe('claude')
    expect(config.harness.review.kind).toBe('codex')
    expect(config.loop.maxParallel).toBe(1)
    expect(config.loop.questionTimeoutSec).toBe(540)
    expect(config.loop.questionParkTimeoutSec).toBe(3600)
  })

  test('the question timeout stays under the 600s harness Bash cap', () => {
    expect(loadConfig(repo).config.loop.questionTimeoutSec).toBeLessThan(600)
  })

  test('repo config overrides global, key by key', () => {
    writeGlobal('[forge]\nkind = "github"\n\n[loop]\nmaxParallel = 4\n')
    writeRepo('[forge]\nkind = "forgejo"\n')
    const { config, sources } = loadConfig(repo)
    expect(config.forge.kind).toBe('forgejo')
    expect(config.loop.maxParallel).toBe(4)
    expect(sources).toHaveLength(2)
  })

  test('arrays are replaced wholesale, not merged', () => {
    writeGlobal('[checks]\ncommands = ["bun test", "bun run lint"]\n')
    writeRepo('[checks]\ncommands = ["just check"]\n')
    expect(loadConfig(repo).config.checks.commands).toEqual(['just check'])
  })

  test('worktreeRoot is tilde expanded', () => {
    writeRepo('[repo]\nworktreeRoot = "~/wt"\n')
    const root = loadConfig(repo).config.repo.worktreeRoot
    expect(root.startsWith('~')).toBe(false)
    expect(root.endsWith('/wt')).toBe(true)
  })

  test('harness permissions default to the narrow setting', () => {
    expect(loadConfig(repo).config.harness.implement.permissions).toBe('workspace-write')
  })

  test('accepts a per-harness binary override', () => {
    writeRepo('[harness.implement]\nkind = "opencode"\nbin = "opencode-unconfined"\n')
    expect(loadConfig(repo).config.harness.implement.bin).toBe('opencode-unconfined')
  })

  test('an unknown enum value fails loudly and names the file', () => {
    writeRepo('[tracker]\nkind = "jira"\n')
    expect(() => loadConfig(repo)).toThrow(/config\.toml/)
  })

  test('malformed toml is not swallowed', () => {
    writeRepo('[tracker\nkind = "beads"\n')
    expect(() => loadConfig(repo)).toThrow()
  })
})
