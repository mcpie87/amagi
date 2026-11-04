import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Diagnostic, diagnoseRepo } from './diagnose.ts'
import type { RegistryEntry } from './registry.ts'
import { Workspaces } from './workspace.ts'

let dir: string
let repo: string
const savedState = process.env.XDG_STATE_HOME
const savedConfig = process.env.XDG_CONFIG_HOME
const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'FORGEJO_TOKEN', 'GITEA_SERVER_TOKEN', 'TEA_TOKEN']
const savedTokens = TOKEN_VARS.map((name) => process.env[name])
const savedFetch = globalThis.fetch
/** Status the stubbed forge answers every request with, and the URLs it was asked for. */
let apiStatus = 200
let apiRequests: string[] = []

beforeEach(() => {
  for (const name of TOKEN_VARS) delete process.env[name]
  apiStatus = 200
  apiRequests = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    apiRequests.push(String(input))
    return new Response(apiStatus === 200 ? '{"login":"bot"}' : 'bad credentials', {
      status: apiStatus,
    })
  }) as typeof fetch
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
  globalThis.fetch = savedFetch
  TOKEN_VARS.forEach((name, i) => {
    const value = savedTokens[i]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
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
    expect(d('forge github token')).toBeDefined()
    expect(d('worktree root')?.ok).toBe(true)
    expect(d('checks')?.ok).toBe(true)
  })

  test('reports missing project checks as a config error', async () => {
    writeFileSync(join(repo, '.amagi', 'config.toml'), '[repo]\nbaseBranch = "main"\n')
    const config = (await diagnoseRepo(entry())).find((check) => check.name === 'config')
    expect(config?.ok).toBe(false)
    expect(config?.detail).toContain('must declare commands')
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
          'amagi-no-such-harness not on PATH (used by harness.implement, mention watcher, prConflict watcher); shell aliases and functions are not visible, point bin at an executable or an argv list starting with one',
        advisory: true,
      },
    ])
  })

  test('a missing harness an implement worker runs on blocks claims', async () => {
    mkdirSync(join(dir, 'config', 'amagi'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'amagi', 'config.toml'),
      '[[worker]]\nid = "w-1"\nname = "W"\nkind = "claude"\nenabled = true\n',
    )
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[harness.implement]\nkind = "claude"\nbin = "amagi-no-such-harness"\n\n' +
        '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
    )
    const check = (await diagnoseRepo(entry())).find(
      (c) => c.name === 'harness amagi-no-such-harness',
    )
    expect(check?.ok).toBe(false)
    expect(check?.advisory).toBeUndefined()
  })

  test.if(process.platform === 'linux')(
    'a server without pasta on PATH blocks claims',
    async () => {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'bwrap'), '#!/bin/sh\n', { mode: 0o755 })
      const savedPath = process.env.PATH
      process.env.PATH = bin
      try {
        const check = (await diagnoseRepo(entry())).find((c) => c.name === 'sandbox')
        expect(check?.ok).toBe(false)
        expect(check?.advisory).toBeUndefined()
        expect(check?.detail).toStartWith('pasta not on')
      } finally {
        process.env.PATH = savedPath
      }
    },
  )

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

  test('resolves the first element of a harness bin argv prefix', async () => {
    mkdirSync(join(repo, '.amagi'), { recursive: true })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      '[harness.implement]\nkind = "claude"\nbin = ["amagi-no-such-wrapper", "--flag", "claude"]\n\n' +
        '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n',
    )
    const names = (await diagnoseRepo(entry()))
      .filter((c) => c.name.startsWith('harness '))
      .map((c) => c.name)
    expect(names).toEqual(['harness amagi-no-such-wrapper'])
  })
})

describe('forge token probe', () => {
  const CHECKS = '[checks]\nformat = "bun run format"\nlint = "bun run lint"\ntest = "bun test"\n'
  const forgejoRepo = () => {
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@git.example.com:me/app.git'], {
      cwd: repo,
    })
    writeFileSync(
      join(repo, '.amagi', 'config.toml'),
      `[forge]\nkind = "forgejo"\nremote = "origin"\n\n${CHECKS}`,
    )
  }
  const check = (checks: Diagnostic[], name: string) => checks.find((c) => c.name === name)

  test('fails with the HTTP status when the forge rejects the token', async () => {
    process.env.FORGEJO_TOKEN = 'fj_rejected'
    forgejoRepo()
    apiStatus = 401
    const token = check(await diagnoseRepo(entry()), 'forge forgejo token')
    expect(token?.ok).toBe(false)
    expect(token?.detail).toContain('401')
    expect(apiRequests).toEqual(['https://git.example.com/api/v1/user'])
  })

  test('passes with the forge URL when the forge accepts the token', async () => {
    process.env.FORGEJO_TOKEN = 'fj_accepted'
    forgejoRepo()
    const token = check(await diagnoseRepo(entry()), 'forge forgejo token')
    expect(token).toEqual({
      name: 'forge forgejo token',
      ok: true,
      detail: 'https://git.example.com',
    })
  })

  test('names the missing token without calling the forge', async () => {
    forgejoRepo()
    const token = check(await diagnoseRepo(entry()), 'forge forgejo token')
    expect(token?.ok).toBe(false)
    expect(token?.detail).toContain('Forgejo token missing')
    expect(apiRequests).toEqual([])
  })

  test('caches a successful probe per API root and token', async () => {
    process.env.FORGEJO_TOKEN = 'fj_cached'
    forgejoRepo()
    await diagnoseRepo(entry())
    apiStatus = 401
    expect(check(await diagnoseRepo(entry()), 'forge forgejo token')?.ok).toBe(true)
    expect(apiRequests).toHaveLength(1)
  })

  test('does not cache a rejected token, so a fix shows at the next check', async () => {
    process.env.FORGEJO_TOKEN = 'fj_fixed_later'
    forgejoRepo()
    apiStatus = 403
    expect(check(await diagnoseRepo(entry()), 'forge forgejo token')?.ok).toBe(false)
    apiStatus = 200
    expect(check(await diagnoseRepo(entry()), 'forge forgejo token')?.ok).toBe(true)
    expect(apiRequests).toHaveLength(2)
  })

  test('probes a github tracker over the api instead of the gh binary', async () => {
    process.env.GH_TOKEN = 'ghp_tracker'
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:me/app.git'], { cwd: repo })
    writeFileSync(join(repo, '.amagi', 'config.toml'), `[tracker]\nkind = "github"\n\n${CHECKS}`)
    const tracker = check(await diagnoseRepo(entry()), 'tracker github')
    expect(tracker).toEqual({ name: 'tracker github', ok: true, detail: 'https://github.com' })
    expect(apiRequests).toEqual(['https://api.github.com/user'])
  })
})

describe('Workspaces.readiness', () => {
  test('serves the latest diagnosis until the next diagnose refreshes it', async () => {
    const workspaces = new Workspaces({ registryPath: join(dir, 'registry.json') })
    const registered = workspaces.add(repo)
    const configOk = (checks: Diagnostic[]) => checks.find((c) => c.name === 'config')?.ok
    expect(configOk(await workspaces.readiness(registered.key))).toBe(true)
    writeFileSync(join(repo, '.amagi', 'config.toml'), 'not toml [')
    expect(configOk(await workspaces.readiness(registered.key))).toBe(true)
    await workspaces.diagnose(registered)
    expect(configOk(await workspaces.readiness(registered.key))).toBe(false)
  })
})
