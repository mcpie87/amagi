import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from '../exec.ts'
import { forgeToken, ghEnv, gitRewrite, gitTokenConfig, parseRemote, teaEnv } from './forge-cred.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd)
    if (opts?.stdin !== undefined) calls.push(['<stdin>', opts.stdin])
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

const savedToken = process.env.GH_TOKEN
const savedForgejoToken = process.env.FORGEJO_TOKEN
const savedState = process.env.XDG_STATE_HOME
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amagi-cred-'))
  process.env.XDG_STATE_HOME = home
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.FORGEJO_TOKEN
  delete process.env.GITEA_SERVER_TOKEN
  delete process.env.TEA_TOKEN
})

afterEach(() => {
  if (savedToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = savedToken
  if (savedForgejoToken === undefined) delete process.env.FORGEJO_TOKEN
  else process.env.FORGEJO_TOKEN = savedForgejoToken
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(home, { recursive: true, force: true })
})

describe('forgeToken', () => {
  test('reads the github token from the process environment', () => {
    process.env.GH_TOKEN = 'ghp_abc'
    expect(forgeToken('github')).toBe('ghp_abc')
    expect(forgeToken('forgejo')).toBeNull()
  })

  test('reads the forgejo token from FORGEJO_TOKEN', () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    expect(forgeToken('forgejo')).toBe('fj_tok')
    expect(forgeToken('github')).toBeNull()
  })
})

describe('parseRemote', () => {
  test('splits ssh scp-form remotes into base and slug', () => {
    expect(parseRemote('git@git.example.com:owner/repo.git')).toEqual({
      base: 'https://git.example.com',
      ownerRepo: 'owner/repo',
    })
  })

  test('splits https remotes and keeps the scheme', () => {
    expect(parseRemote('https://github.com/owner/repo.git')).toEqual({
      base: 'https://github.com',
      ownerRepo: 'owner/repo',
    })
    expect(parseRemote('http://127.0.0.1:3000/o/r.git')).toEqual({
      base: 'http://127.0.0.1:3000',
      ownerRepo: 'o/r',
    })
  })

  test('rejects a remote with no host or path', () => {
    expect(parseRemote('not a remote')).toBeNull()
    expect(parseRemote('')).toBeNull()
  })
})

describe('gitRewrite', () => {
  test('embeds the token as basic auth on the https form, keeping the path', () => {
    expect(gitRewrite('git@github.com:mcpie87/amagi.git', 'tok')).toEqual({
      from: 'git@github.com:',
      to: 'https://x-access-token:tok@github.com/',
    })
  })

  test('rewrites https and http remotes with their scheme and port', () => {
    expect(gitRewrite('https://github.com/owner/repo.git', 'tok')).toEqual({
      from: 'https://github.com/',
      to: 'https://x-access-token:tok@github.com/',
    })
    expect(gitRewrite('http://127.0.0.1:3000/o/r.git', 'tok')).toEqual({
      from: 'http://127.0.0.1:3000/',
      to: 'http://x-access-token:tok@127.0.0.1:3000/',
    })
  })

  test('rejects a remote with no host or path', () => {
    expect(gitRewrite('not a remote', 'tok')).toBeNull()
  })
})

describe('ghEnv', () => {
  test('isolates gh config from the operator while carrying the token', () => {
    process.env.GH_TOKEN = 'ghp_abc'
    const env = ghEnv()
    expect(env.GH_TOKEN).toBe('ghp_abc')
    expect(env.GH_CONFIG_DIR).toContain(join(home, 'amagi', 'forge', 'github'))
  })

  test('still isolates gh config without a token so it fails closed', () => {
    const env = ghEnv()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GH_CONFIG_DIR).toContain(join(home, 'amagi', 'forge', 'github'))
  })
})

describe('gitTokenConfig', () => {
  test('provisions nothing and rewrites nothing without a token', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('get-url') ? ok('git@github.com:x/y.git') : undefined,
    )
    expect(await gitTokenConfig(exec, '/repo', 'origin', null)).toEqual([])
    expect(calls).toHaveLength(0)
  })

  test('reads the remote and rewrites it once with a token', async () => {
    const { exec } = fake((c) => (c.includes('get-url') ? ok('git@github.com:x/y.git') : undefined))
    const [flag, cfg] = await gitTokenConfig(exec, '/repo', 'origin', 'tok')
    expect(flag).toBe('-c')
    expect(cfg).toBe('url.https://x-access-token:tok@github.com/.insteadOf=git@github.com:')
  })
})

describe('teaEnv', () => {
  test('provisions a tea login from the token and points tea at the Amagi xdg', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec, calls } = fake((c) => {
      if (c.includes('get-url')) return ok('git@git.example.com:owner/repo.git')
      if (c[0] === 'tea' && c[1] === 'logins') return ok('')
      return undefined
    })
    const env = await teaEnv(exec, '/repo')
    expect(env.XDG_CONFIG_HOME).toContain(join(home, 'amagi', 'forge', 'tea'))
    expect(calls).toContainEqual([
      'tea',
      'logins',
      'add',
      '--name',
      'amagi',
      '--url',
      'https://git.example.com',
      '--token',
      'fj_tok',
      '--no-version-check',
    ])
  })

  test('skips provisioning without a token', async () => {
    const { exec, calls } = fake(() => undefined)
    const env = await teaEnv(exec, '/repo')
    expect(env.XDG_CONFIG_HOME).toContain(join(home, 'amagi', 'forge', 'tea'))
    expect(calls.some((c) => c[0] === 'tea')).toBe(false)
  })

  test('reuses an existing profile instead of re-provisioning', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const dir = join(home, 'amagi', 'forge', 'tea', 'tea')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yml'), 'logins: []\n')
    const { exec, calls } = fake((c) =>
      c.includes('get-url') ? ok('git@git.example.com:o/r.git') : undefined,
    )
    await teaEnv(exec, '/repo')
    expect(calls.some((c) => c[0] === 'tea')).toBe(false)
  })
})
