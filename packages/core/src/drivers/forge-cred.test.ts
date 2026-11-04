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
  gitRewrite,
  gitTokenConfig,
  listForgeCredentials,
  parseRemote,
  pickForgeCredential,
  removeForgeCredential,
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
    updateForgeCredential(bot.id, { url: null })
    expect(listForgeCredentials()[0]?.url).toBeNull()
    expect(forgeUrl('gitlab', repo)).toBeNull()
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

  test('sends ssh remotes to the forge URL, never to the ssh port', () => {
    expect(gitRewrite('ssh://git@git.lan:2222/o/r.git', 'tok')).toEqual({
      from: 'ssh://git@git.lan:2222/',
      to: 'https://x-access-token:tok@git.lan/',
    })
    expect(
      gitRewrite('ssh://git@git.lan:2222/o/r.git', 'tok', 'http://git.lan:3000/forge'),
    ).toEqual({
      from: 'ssh://git@git.lan:2222/',
      to: 'http://x-access-token:tok@git.lan:3000/forge/',
    })
    expect(gitRewrite('git@git.lan:o/r.git', 'tok', 'https://git.lan:3000/forge')).toEqual({
      from: 'git@git.lan:',
      to: 'https://x-access-token:tok@git.lan:3000/forge/',
    })
  })

  test('rejects a remote with no host or path', () => {
    expect(gitRewrite('not a remote', 'tok')).toBeNull()
  })
})

describe('gitTokenConfig', () => {
  test('provisions nothing and rewrites nothing without a token', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('get-url') ? ok('git@github.com:x/y.git') : undefined,
    )
    expect(await gitTokenConfig(exec, '/repo', 'origin', null, 'github')).toEqual({})
    expect(calls).toHaveLength(0)
  })

  test('reads the remote and rewrites it once with a token', async () => {
    const { exec } = fake((c) => (c.includes('get-url') ? ok('git@github.com:x/y.git') : undefined))
    expect(await gitTokenConfig(exec, '/repo', 'origin', 'tok', 'github')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:tok@github.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@github.com:',
    })
  })

  test('rewrites an ssh remote to the configured forge URL', async () => {
    const repo = join(home, 'fj')
    mkdirSync(repo)
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
    addForgeCredential('forgejo', 'bot', 'fj_tok', 'http://git.lan:3000')
    const { exec } = fake((c) =>
      c.includes('get-url') ? ok('ssh://git@git.lan:2222/o/r.git') : undefined,
    )
    expect(await gitTokenConfig(exec, repo, 'origin', 'fj_tok', 'forgejo')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.http://x-access-token:fj_tok@git.lan:3000/.insteadOf',
      GIT_CONFIG_VALUE_0: 'ssh://git@git.lan:2222/',
    })
  })
})
