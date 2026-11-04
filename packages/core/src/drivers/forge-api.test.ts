import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from '../exec.ts'
import {
  ForgeApiError,
  type ForgeEndpoint,
  forgeFetch,
  forgePages,
  isForgeAuthError,
  resolveForge,
} from './forge-api.ts'
import { addForgeCredential } from './forge-cred.ts'

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

const remoteExec =
  (url: string): Exec =>
  async () =>
    ok(`${url}\n`)

const withFetch = <T>(
  reply: (url: string, init: RequestInit) => Response,
  fn: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    reply(String(input), init ?? {})) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const gitlab: ForgeEndpoint = {
  kind: 'gitlab',
  base: 'https://gitlab.example.com',
  apiRoot: 'https://gitlab.example.com/api/v4',
  ownerRepo: 'owner/repo',
  token: 'tok',
}

const savedState = process.env.XDG_STATE_HOME
let state: string

beforeEach(() => {
  // Stored credentials and env tokens would otherwise leak in from the operator's machine.
  state = mkdtempSync(join(tmpdir(), 'amagi-forge-api-'))
  process.env.XDG_STATE_HOME = state
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN']) {
    delete process.env[name]
  }
  delete process.env.FORGEJO_TOKEN
})

afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(state, { recursive: true, force: true })
})

describe('resolveForge', () => {
  test('derives the web base from an ssh remote and drops its port', async () => {
    process.env.GITLAB_TOKEN = 'tok'
    const forge = await resolveForge(
      'gitlab',
      '/wt',
      'origin',
      remoteExec('ssh://git@gitlab.enigma.com.pl:2222/group/repo.git'),
    )
    expect(forge).toEqual({
      kind: 'gitlab',
      base: 'https://gitlab.enigma.com.pl',
      apiRoot: 'https://gitlab.enigma.com.pl/api/v4',
      ownerRepo: 'group/repo',
      token: 'tok',
    })
  })

  test('prefers the credential url over the remote host', async () => {
    addForgeCredential('gitlab', 'internal', 'tok', 'https://gitlab.internal.example/')
    const forge = await resolveForge(
      'gitlab',
      '/wt',
      'origin',
      remoteExec('git@gitlab.com:owner/repo.git'),
    )
    expect(forge.base).toBe('https://gitlab.internal.example')
    expect(forge.apiRoot).toBe('https://gitlab.internal.example/api/v4')
  })

  test('uses the GitHub.com API host, and /api/v3 on Enterprise', async () => {
    process.env.GH_TOKEN = 'ghp'
    const cloud = await resolveForge(
      'github',
      '/wt',
      'origin',
      remoteExec('git@github.com:o/r.git'),
    )
    const enterprise = await resolveForge(
      'github',
      '/wt',
      'origin',
      remoteExec('git@ghe.example.com:o/r.git'),
    )
    expect(cloud.apiRoot).toBe('https://api.github.com')
    expect(enterprise.apiRoot).toBe('https://ghe.example.com/api/v3')
  })

  test('names the repository setting and env var when no token resolves', async () => {
    await expect(
      resolveForge('gitlab', '/wt', 'origin', remoteExec('git@gitlab.com:o/r.git')),
    ).rejects.toThrow(/repository settings or GITLAB_TOKEN/)
  })
})

describe('forgeFetch', () => {
  test('authenticates each forge with its own header', async () => {
    const forges: ForgeEndpoint[] = [
      { ...gitlab, kind: 'github', apiRoot: 'https://api.github.com' },
      gitlab,
      { ...gitlab, kind: 'forgejo', apiRoot: 'https://gitlab.example.com/api/v1' },
    ]
    const headers: unknown[] = []
    await withFetch(
      (_url, init) => {
        headers.push(init.headers)
        return new Response('{}')
      },
      async () => {
        for (const forge of forges) await forgeFetch(forge, 'GET', 'user')
      },
    )
    expect(headers).toEqual([
      { authorization: 'Bearer tok' },
      { 'PRIVATE-TOKEN': 'tok' },
      { authorization: 'token tok' },
    ])
  })

  test('throws a ForgeApiError carrying the status and the first 300 bytes of the body', async () => {
    const failure = await withFetch(
      () => new Response('x'.repeat(400), { status: 404 }),
      () =>
        forgeFetch(gitlab, 'GET', 'projects/owner%2Frepo').then(
          () => undefined,
          (err: unknown) => err,
        ),
    )
    expect(failure).toBeInstanceOf(ForgeApiError)
    expect((failure as ForgeApiError).status).toBe(404)
    expect((failure as Error).message).toBe(
      `gitlab api GET projects/owner%2Frepo: 404 ${'x'.repeat(300)}`,
    )
  })
})

describe('isForgeAuthError', () => {
  test('matches a missing token and a 401 or 403, not other failures', async () => {
    const missing = await resolveForge(
      'gitlab',
      '/wt',
      'origin',
      remoteExec('git@gitlab.com:o/r.git'),
    ).catch((err: unknown) => err)
    expect(isForgeAuthError(missing)).toBe(true)
    expect(isForgeAuthError(new ForgeApiError('rejected', 401))).toBe(true)
    expect(isForgeAuthError(new ForgeApiError('rejected', 403))).toBe(true)
    expect(isForgeAuthError(new ForgeApiError('missing', 404))).toBe(false)
    expect(isForgeAuthError(new Error('auth failed'))).toBe(false)
  })
})

describe('forgePages', () => {
  test('follows GitHub Link rel=next until the last page', async () => {
    const github: ForgeEndpoint = {
      ...gitlab,
      kind: 'github',
      apiRoot: 'https://api.github.com',
    }
    const urls: string[] = []
    const items = await withFetch(
      (url) => {
        urls.push(url)
        const page = new URL(url).searchParams.get('page')
        if (page === '1') {
          return new Response('[{"n":1}]', {
            headers: { link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"' },
          })
        }
        return new Response('[{"n":2}]', {
          headers: { link: '<https://api.github.com/repos/o/r/pulls?page=1>; rel="prev"' },
        })
      },
      () => forgePages(github, 'repos/o/r/pulls'),
    )
    expect(items).toEqual([{ n: 1 }, { n: 2 }])
    expect(urls).toEqual([
      'https://api.github.com/repos/o/r/pulls?per_page=100&page=1',
      'https://api.github.com/repos/o/r/pulls?per_page=100&page=2',
    ])
  })

  test('follows GitLab x-next-page until it comes back empty', async () => {
    const items = await withFetch(
      (url) => {
        const page = new URL(url).searchParams.get('page')
        return new Response(JSON.stringify([{ page }]), {
          headers: { 'x-next-page': page === '1' ? '2' : '' },
        })
      },
      () => forgePages(gitlab, 'projects/owner%2Frepo/notes'),
    )
    expect(items).toEqual([{ page: '1' }, { page: '2' }])
  })
})
