import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hasStaleMaxParallel,
  loadConfig,
  loadGlobalConfig,
  migrateFleet,
  newWorkerId,
  watcherHarnessConfig,
  workerSeat,
  writeConfig,
  writeGlobalConfig,
} from './config.ts'

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
    expect(config.worker).toEqual([])
    expect(config.watchers).toMatchObject({
      mention: { enabled: true },
      prConflict: { enabled: true },
      stall: { enabled: true },
    })
    expect(config.loop.questionTimeoutSec).toBe(540)
    expect(config.loop.questionParkTimeoutSec).toBe(3600)
    expect(config.loop.mentionWatchIntervalSec).toBe(300)
    expect(config.loop.prCheckIntervalSec).toBe(300)
    expect(config.loop.mergeTreeCheck).toBe(false)
    expect(config.loop.stallWatchIntervalSec).toBe(300)
    expect(config.loop.stallTimeoutSec).toBe(3600)
    expect(config.loop.contextWarnTokens).toBe(160_000)
    expect(config.loop.contextMaxTokens).toBe(200_000)
    expect(config.loop.contextMaxRestarts).toBe(1)
    expect(config.loop.contextOverrides).toEqual({})
    expect(config.loop.doomEnabled).toBe(true)
    expect(config.loop.doomToolWindowSec).toBe(600)
    expect(config.loop.doomToolRepeat).toBe(20)
    expect(config.loop.doomCheckRounds).toBe(3)
    expect(config.loop.doomDiffWindowSec).toBe(1800)
    expect(config.loop.maxRunMinutes).toBe(0)
    expect(config.loop.maxCostUsd).toBe(0)
  })

  test('the question timeout stays under the 600s harness Bash cap', () => {
    expect(loadConfig(repo).config.loop.questionTimeoutSec).toBeLessThan(600)
  })

  test('stale maxParallel is ignored while other config resolves', () => {
    writeGlobal('[forge]\nkind = "github"\n\n[loop]\nmaxParallel = 4\n')
    writeRepo('[forge]\nkind = "forgejo"\n')
    const { config, sources } = loadConfig(repo)
    expect(config.forge.kind).toBe('forgejo')
    expect(config.loop.autoQueue).toBe(false)
    expect(hasStaleMaxParallel(repo)).toBe(true)
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

  test('repo persona defaults to none', () => {
    expect(loadConfig(repo).config.repo.persona).toBeNull()
  })

  test('accepts a repo persona', () => {
    writeRepo('[repo]\npersona = "agent-chise"\n')
    expect(loadConfig(repo).config.repo.persona).toBe('agent-chise')
  })

  test('forge agent handle defaults to the agent account and is overridable', () => {
    expect(loadConfig(repo).config.forge.agentHandle).toBe('chise-maru')
    writeRepo('[forge]\nagentHandle = "chise"\n')
    expect(loadConfig(repo).config.forge.agentHandle).toBe('chise')
  })

  test('accepts a per-harness binary override', () => {
    writeRepo('[harness.implement]\nkind = "opencode"\nbin = "opencode-unconfined"\n')
    expect(loadConfig(repo).config.harness.implement.bin).toBe('opencode-unconfined')
  })

  test('accepts named harness definitions for the interactive picker', () => {
    writeRepo(
      '[harness.definitions.fast]\nkind = "opencode"\npermissions = "bypass"\nmodel = "local/x"\n',
    )
    const config = loadConfig(repo).config
    expect(config.harness.definitions.fast).toMatchObject({
      kind: 'opencode',
      permissions: 'bypass',
      model: 'local/x',
    })
    expect(config.harness.implement.kind).toBe('claude')
  })

  test('loads workers with stable identity and defaults them disabled', () => {
    writeGlobal('[[worker]]\nid = "w-fast"\nname = "Fast"\nkind = "opencode"\n')
    expect(loadConfig(repo).config.worker[0]).toMatchObject({
      id: 'w-fast',
      name: 'Fast',
      enabled: false,
    })
  })

  test('accepts a per-harness tool allowlist', () => {
    writeRepo('[harness.implement]\nkind = "claude"\nallowedTools = ["Read", "Bash"]\n')
    expect(loadConfig(repo).config.harness.implement.allowedTools).toEqual(['Read', 'Bash'])
  })

  test('watcher settings default on and inherit implement harness fields', () => {
    writeRepo(
      '[harness.implement]\nkind = "claude"\nmodel = "base-model"\neffort = "medium"\nseat = "shared"\n\n' +
        '[watchers.mention]\nenabled = false\nmodel = "mention-model"\nseat = "mention-seat"\n\n' +
        '[watchers.prConflict]\neffort = "high"\n\n' +
        '[watchers.stall]\nenabled = false\n',
    )
    const config = loadConfig(repo).config
    expect(config.watchers.mention.enabled).toBe(false)
    expect(config.watchers.mention).toMatchObject({
      enabled: false,
      model: 'mention-model',
      seat: 'mention-seat',
    })
    expect(config.watchers.prConflict.enabled).toBe(true)
    expect(config.watchers.stall.enabled).toBe(false)
    expect(watcherHarnessConfig(config, 'mention')).toMatchObject({
      kind: 'claude',
      model: 'mention-model',
      effort: 'medium',
      seat: 'mention-seat',
    })
    expect(watcherHarnessConfig(config, 'prConflict')).toMatchObject({
      kind: 'claude',
      model: 'base-model',
      effort: 'high',
      seat: 'shared',
    })
  })

  test('a watcher on a different harness kind does not inherit the implement bin or args', () => {
    writeRepo(
      '[harness.implement]\nkind = "codex"\nbin = "codex-unconfined"\nmodel = "gpt-x"\npermissions = "bypass"\nextraArgs = ["--foo"]\n\n' +
        '[watchers.prConflict]\nkind = "claude"\n',
    )
    const harness = watcherHarnessConfig(loadConfig(repo).config, 'prConflict')
    expect(harness).toMatchObject({ kind: 'claude', permissions: 'bypass', extraArgs: [] })
    expect(harness.bin).toBeUndefined()
    expect(harness.model).toBeUndefined()
  })

  test('an unknown enum value fails loudly and names the file', () => {
    writeRepo('[tracker]\nkind = "jira"\n')
    expect(() => loadConfig(repo)).toThrow(/config\.toml/)
  })

  test('malformed toml is not swallowed', () => {
    writeRepo('[tracker\nkind = "beads"\n')
    expect(() => loadConfig(repo)).toThrow()
  })

  test('ignores stale maxParallel above the former ceiling', () => {
    writeRepo('[loop]\nmaxParallel = 100\n')
    expect(loadConfig(repo).config.loop.autoQueue).toBe(false)
    expect(hasStaleMaxParallel(repo)).toBe(true)
  })

  test('stall watcher keys are overridable', () => {
    writeRepo('[loop]\nstallWatchIntervalSec = 60\nstallTimeoutSec = 7200\n')
    const config = loadConfig(repo).config
    expect(config.loop.stallWatchIntervalSec).toBe(60)
    expect(config.loop.stallTimeoutSec).toBe(7200)
  })

  test('context budget keys are overridable, including per-harness', () => {
    writeRepo(
      '[loop]\ncontextWarnTokens = 90000\ncontextMaxTokens = 120000\ncontextMaxRestarts = 3\n\n' +
        '[loop.contextOverrides.codex]\nmaxTokens = 110000\n',
    )
    const config = loadConfig(repo).config
    expect(config.loop.contextWarnTokens).toBe(90_000)
    expect(config.loop.contextMaxTokens).toBe(120_000)
    expect(config.loop.contextMaxRestarts).toBe(3)
    expect(config.loop.contextOverrides).toEqual({ codex: { maxTokens: 110_000 } })
  })

  test('pr check interval is overridable', () => {
    writeRepo('[loop]\nprCheckIntervalSec = 120\n')
    expect(loadConfig(repo).config.loop.prCheckIntervalSec).toBe(120)
  })

  test('doom guard keys are overridable and can be disabled', () => {
    writeRepo(
      '[loop]\ndoomEnabled = false\ndoomToolWindowSec = 60\ndoomToolRepeat = 5\ndoomCheckRounds = 2\ndoomDiffWindowSec = 120\n',
    )
    const config = loadConfig(repo).config
    expect(config.loop.doomEnabled).toBe(false)
    expect(config.loop.doomToolWindowSec).toBe(60)
    expect(config.loop.doomToolRepeat).toBe(5)
    expect(config.loop.doomCheckRounds).toBe(2)
    expect(config.loop.doomDiffWindowSec).toBe(120)
  })

  test('per-task budget keys are overridable', () => {
    writeRepo('[loop]\nmaxRunMinutes = 90\nmaxCostUsd = 4.5\n')
    const config = loadConfig(repo).config
    expect(config.loop.maxRunMinutes).toBe(90)
    expect(config.loop.maxCostUsd).toBe(4.5)
  })
})

describe('writeConfig', () => {
  test('merges a patch into the repo config and preserves other keys', () => {
    writeRepo('[forge]\nkind = "forgejo"\n\n[loop]\nmaxParallel = 1\n')
    writeConfig(repo, { loop: { autoQueue: true } })
    const { config } = loadConfig(repo)
    expect(config.loop.autoQueue).toBe(true)
    expect(config.forge.kind).toBe('forgejo')
  })

  test('creates the repo config file when absent', () => {
    writeConfig(repo, { loop: { autoQueue: true } })
    expect(loadConfig(repo).config.loop.autoQueue).toBe(true)
  })
})

describe('worker fleet', () => {
  const fleet = [
    {
      id: 'w-aaaaaa',
      name: 'Claude 1',
      kind: 'claude',
      model: 'claude-opus-5-5',
      seat: 'personal',
      enabled: true,
    },
    { id: 'w-bbbbbb', name: 'Codex 1', kind: 'codex', effort: 'high', enabled: false },
  ] as const

  test('round-trips through writeGlobalConfig', () => {
    writeGlobal('[server]\nport = 9000\n')
    writeGlobalConfig({ worker: fleet })
    const config = loadGlobalConfig()
    expect(config.worker).toEqual([...fleet])
    expect(config.server.port).toBe(9000)
    expect(loadConfig(repo).config.worker).toEqual([...fleet])
  })

  test('seat defaults to the harness kind', () => {
    writeGlobalConfig({ worker: fleet })
    expect(loadGlobalConfig().worker.map(workerSeat)).toEqual(['personal', 'codex'])
  })

  test('renaming a worker keeps its id', () => {
    writeGlobalConfig({ worker: fleet })
    const renamed = loadGlobalConfig().worker.map((w) =>
      w.id === 'w-aaaaaa' ? { ...w, name: 'Main' } : w,
    )
    writeGlobalConfig({ worker: renamed })
    expect(loadGlobalConfig().worker.map((w) => [w.id, w.name])).toEqual([
      ['w-aaaaaa', 'Main'],
      ['w-bbbbbb', 'Codex 1'],
    ])
  })

  test('rejects duplicate worker ids', () => {
    writeGlobalConfig({ worker: [fleet[0], { ...fleet[1], id: fleet[0].id }] })
    expect(() => loadGlobalConfig()).toThrow(/worker ids must be unique/)
  })

  test('rejects [[worker]] in a repo config, naming the global path', () => {
    writeRepo('[[worker]]\nid = "w-1"\nname = "x"\nkind = "claude"\n')
    expect(() => loadConfig(repo)).toThrow(join(home, 'amagi', 'config.toml'))
  })

  test('newWorkerId avoids taken ids', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 50; i++) taken.add(newWorkerId(taken))
    expect(taken.size).toBe(50)
    for (const id of taken) expect(id).toMatch(/^w-[a-z0-9-]+$/)
  })

  test('migrates to one worker regardless of stale maxParallel, once', () => {
    writeGlobal(
      '[harness.implement]\nkind = "claude"\nmodel = "claude-sonnet-5"\n\n[loop]\nmaxParallel = 3\n',
    )
    const created = migrateFleet()
    expect(created.map((w) => [w.name, w.kind, w.seat, w.model])).toEqual([
      ['Claude 1', 'claude', 'claude', 'claude-sonnet-5'],
    ])
    expect(new Set(created.map((w) => w.id)).size).toBe(1)
    expect(loadGlobalConfig().worker).toEqual(created)
    const written = readFileSync(join(home, 'amagi', 'config.toml'), 'utf8')
    expect(migrateFleet()).toEqual([])
    expect(readFileSync(join(home, 'amagi', 'config.toml'), 'utf8')).toBe(written)
  })

  test('an explicitly empty fleet is not migrated again', () => {
    writeGlobalConfig({ worker: [] })
    expect(migrateFleet()).toEqual([])
  })
})
