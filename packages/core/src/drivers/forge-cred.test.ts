import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from '../exec.ts'
import {
  addForgeCredential,
  forgeToken,
  forgeTokenStates,
  forgeTokensPath,
  forgeUrl,
  ghEnv,
  gitRewrite,
  gitTokenConfig,
  glabEnv,
  listForgeCredentials,
  parseRemote,
  pickForgeCredential,
  removeForgeCredential,
  teaEnv,
  teaRepoArgs,
  teaXdgHome,
  updateForgeCredential,
} from './forge-cred.ts'

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

describe('forge credentials', () => {
  function repoWithWorktree(): { repo: string; worktree: string } {
    const repo = join(home, 'repo')
    const worktree = join(home, 'wt')
    mkdirSync(repo)
    const git = (...args: string[]) =>
      Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
    git('init', '-q')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', worktree)
    return { repo, worktree }
  }

  test('the only credential for a forge beats the env and covers worktrees', () => {
    process.env.GITLAB_TOKEN = 'env_tok'
    try {
      const { repo, worktree } = repoWithWorktree()
      expect(forgeTokenStates(repo).gitlab).toEqual({ credential: null, source: 'environment' })
      const bot = addForgeCredential('gitlab', 'bot', 'bot_tok')
      expect(forgeToken('gitlab', repo)).toBe('bot_tok')
      expect(forgeToken('gitlab', worktree)).toBe('bot_tok')
      expect(forgeTokenStates(repo).gitlab).toEqual({ credential: bot.id, source: 'only' })
      expect(forgeToken('github', repo)).toBeNull()
      removeForgeCredential(bot.id)
      expect(forgeToken('gitlab', repo)).toBe('env_tok')
    } finally {
      delete process.env.GITLAB_TOKEN
    }
  })

  test('with several credentials a repo uses its pick, and rotation reaches it', () => {
    const { repo } = repoWithWorktree()
    const personal = addForgeCredential('github', 'personal', 'tok_a')
    const org = addForgeCredential('github', 'org', 'tok_b')
    expect(forgeToken('github', repo)).toBeNull()
    expect(pickForgeCredential(repo, 'github', org.id)).toBe(true)
    expect(forgeTokenStates(repo).github).toEqual({ credential: org.id, source: 'picked' })
    updateForgeCredential(org.id, { token: 'tok_b2' })
    expect(forgeToken('github', repo)).toBe('tok_b2')
    expect(pickForgeCredential(repo, 'gitlab', personal.id)).toBe(false)
    removeForgeCredential(org.id)
    expect(forgeTokenStates(repo).github).toEqual({ credential: personal.id, source: 'only' })
    expect(JSON.stringify(listForgeCredentials())).not.toContain('tok_')
  })

  test('a credential carries its server URL until it is cleared', () => {
    const { repo } = repoWithWorktree()
    const bot = addForgeCredential('gitlab', 'bot', 'tok', 'https://example.com/gitlab/')
    expect(bot.url).toBe('https://example.com/gitlab')
    expect(forgeUrl('gitlab', repo)).toBe('https://example.com/gitlab')
    expect(glabEnv(repo, 'origin')).toMatchObject({
      GITLAB_TOKEN: 'tok',
      GITLAB_API_HOST: 'example.com/gitlab',
      GLAB_API_PROTOCOL: 'https',
    })
    updateForgeCredential(bot.id, { url: null })
    expect(listForgeCredentials()[0]?.url).toBeNull()
    expect(glabEnv(repo, 'origin').GITLAB_API_HOST).toBeUndefined()
  })

  test('migrates per-repo tokens into shared credentials, one per distinct token', () => {
    const { repo } = repoWithWorktree()
    const other = join(home, 'other')
    mkdirSync(join(home, 'amagi', 'forge'), { recursive: true })
    writeFileSync(
      forgeTokensPath(),
      JSON.stringify({ [repo]: { github: 'same' }, [other]: { github: 'same', forgejo: 'fj' } }),
    )
    const credentials = listForgeCredentials()
    expect(credentials.map(({ kind }) => kind).sort()).toEqual(['forgejo', 'github'])
    expect(listForgeCredentials()).toEqual(credentials)
    expect(forgeToken('github', repo)).toBe('same')
  })
})

describe('remote pinning', () => {
  test('gh, glab and tea target the configured remote, not whichever they prefer', () => {
    const repo = join(home, 'multi')
    mkdirSync(repo)
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo })
    git('init', '-q')
    git('remote', 'add', 'origin', 'git@github.com:me/app.git')
    git('remote', 'add', 'gitlab', 'git@gitlab.example.com:group/app.git')
    expect(ghEnv(repo, 'origin').GH_REPO).toBe('github.com/me/app')
    expect(glabEnv(repo, 'gitlab').GLAB_REMOTE_ALIAS).toBe('gitlab')
    expect(teaRepoArgs(repo, 'gitlab')).toEqual(['--login', 'amagi', '--repo', 'group/app'])
    expect(teaRepoArgs(repo, 'missing')).toEqual([])
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
    const env = ghEnv(home, 'origin')
    expect(env.GH_TOKEN).toBe('ghp_abc')
    expect(env.GH_CONFIG_DIR).toContain(join(home, 'amagi', 'forge', 'github'))
  })

  test('still isolates gh config without a token so it fails closed', () => {
    const env = ghEnv(home, 'origin')
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
    const env = await teaEnv(exec, '/repo', 'origin')
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

  test('logs tea into the credential URL instead of the origin host', async () => {
    const repo = join(home, 'fj')
    mkdirSync(repo)
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
    addForgeCredential('forgejo', 'bot', 'fj_tok', 'http://forge.lan:3000')
    const { exec, calls } = fake((c) =>
      c.includes('get-url') ? ok('ssh://git@git.lan:2222/o/r.git') : undefined,
    )
    const env = await teaEnv(exec, repo, 'origin')
    expect(env.XDG_CONFIG_HOME).toBe(teaXdgHome('fj_tok', 'http://forge.lan:3000'))
    const login = calls.find((c) => c[0] === 'tea')
    expect(login?.[login.indexOf('--url') + 1]).toBe('http://forge.lan:3000')
  })

  test('skips provisioning without a token', async () => {
    const { exec, calls } = fake(() => undefined)
    const env = await teaEnv(exec, '/repo', 'origin')
    expect(env.XDG_CONFIG_HOME).toContain(join(home, 'amagi', 'forge', 'tea'))
    expect(calls.some((c) => c[0] === 'tea')).toBe(false)
  })

  test('reuses an existing profile instead of re-provisioning', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const dir = join(teaXdgHome('fj_tok'), 'tea')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yml'), 'logins: []\n')
    const { exec, calls } = fake((c) =>
      c.includes('get-url') ? ok('git@git.example.com:o/r.git') : undefined,
    )
    await teaEnv(exec, '/repo', 'origin')
    expect(calls.some((c) => c[0] === 'tea')).toBe(false)
  })
})
