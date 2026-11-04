import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from '../exec.ts'
import type { PrInfo } from '../pr-check.ts'
import { gitTokenConfig } from './forge-cred.ts'
import { amagiLabels, makePrDriver } from './pr.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): {
  exec: Exec
  calls: Call[]
  invocations: { cmd: Call; env: Record<string, string> | undefined }[]
} {
  const calls: Call[] = []
  const invocations: { cmd: Call; env: Record<string, string> | undefined }[] = []
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd)
    invocations.push({ cmd, env: opts?.env })
    if (opts?.stdin !== undefined) calls.push(['<stdin>', opts.stdin])
    if (cmd.includes('--symref')) return ok('ref: refs/heads/main\tHEAD\n')
    const hit = routes(cmd)
    if (hit) return hit
    if (cmd.includes('get-url') && cmd.includes('--push'))
      return ok('git@github.com:owner/repo.git\n')
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls, invocations }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

/**
 * Stubs fetch for `fn`; `routes` gets the API path after /api/vN/ (or after
 * api.github.com/), the method, the parsed JSON body and the request headers.
 */
const withFetch = <T>(
  routes: (path: string, method: string, body?: unknown, headers?: Headers) => Response,
  fn: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split(/\/api\/v\d\/|api\.github\.com\//)[1] ?? ''
    return routes(
      path,
      init?.method ?? 'GET',
      init?.body ? JSON.parse(String(init.body)) : undefined,
      new Headers(init?.headers),
    )
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const prInfo = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  body: 'Task: am-1',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefOid: 'deadbeef',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: ['amagi'],
  ...over,
})

const savedState = process.env.XDG_STATE_HOME
let state: string

beforeEach(() => {
  // Stored forge credentials would otherwise leak in from the operator's state dir.
  state = mkdtempSync(join(tmpdir(), 'amagi-pr-state-'))
  process.env.XDG_STATE_HOME = state
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.GITLAB_TOKEN
  delete process.env.FORGEJO_TOKEN
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.GITLAB_TOKEN
  delete process.env.FORGEJO_TOKEN
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(state, { recursive: true, force: true })
})

describe('gitTokenConfig', () => {
  const remote = (url: string): { exec: Exec; calls: Call[] } =>
    fake((c) => (c.includes('get-url') ? ok(url) : undefined))

  test('has no config without a token so git keeps the ssh remote', async () => {
    expect(
      await gitTokenConfig(
        remote('git@github.com:x/y.git').exec,
        '/repo',
        'origin',
        null,
        'github',
      ),
    ).toEqual({})
  })

  test('rewrites the remote to an https token url', async () => {
    const { exec, calls } = remote('git@github.com:mcpie87/amagi.git')
    const auth = await gitTokenConfig(exec, '/repo', 'origin', 'ghp_abc', 'github')
    expect(auth).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:ghp_abc@github.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@github.com:',
    })
    expect(calls[0]).toEqual(['git', 'remote', 'get-url', 'origin'])
  })

  test('is empty when the remote points away from the forge host', async () => {
    const { exec } = remote('https://evil.example/x/y.git')
    expect(await gitTokenConfig(exec, '/repo', 'origin', 'ghp_abc', 'github')).toEqual({})
  })

  test('is empty when the remote cannot be parsed', async () => {
    expect(
      await gitTokenConfig(remote('not-a-remote').exec, '/repo', 'origin', 'tok', 'github'),
    ).toEqual({})
  })
})

describe('amagiLabels', () => {
  test('always carries the provenance label, plus amagi/<type> when typed', () => {
    expect(amagiLabels('bug')).toEqual(['amagi', 'amagi/bug'])
  })

  test('skips the type label when the task has no type', () => {
    expect(amagiLabels(null)).toEqual(['amagi'])
    expect(amagiLabels('')).toEqual(['amagi'])
  })
})

describe('githubPr', () => {
  const remote = () =>
    fake((c) => (c.includes('get-url') ? ok('git@github.com:owner/repo.git') : undefined))
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status })
  const unexpected = (): Response => new Response('unexpected request', { status: 500 })

  /** A single-PR answer; `over` replaces fields, e.g. `mergeable: null` while GitHub computes. */
  const pull = (number: number, over: Record<string, unknown> = {}) => ({
    number,
    title: 'Do the thing',
    body: 'Task: am-1',
    html_url: `https://github.com/owner/repo/pull/${number}`,
    state: 'open',
    merged: false,
    head: { ref: 'amagi/am-1-do-the-thing', sha: 'deadbeef' },
    base: { ref: 'main', sha: 'base-sha' },
    mergeable: true,
    mergeable_state: 'clean',
    labels: [{ name: 'amagi' }],
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-21T10:00:00Z',
    changed_files: 1,
    ...over,
  })

  beforeEach(() => {
    process.env.GH_TOKEN = 'ghp_abc'
  })

  test('pushes over the token rewrite and creates the pr with its labels', async () => {
    const { exec, calls, invocations } = remote()
    const writes: Array<[string, string, unknown]> = []
    const pr = await withFetch(
      (path, method, body) => {
        if (method !== 'GET') writes.push([method, path, body])
        if (
          path ===
          'repos/owner/repo/pulls?state=open&head=owner%3Aamagi%2Fam-1-do-the-thing&per_page=100&page=1'
        ) {
          return json([])
        }
        if (path === 'repos/owner/repo/pulls' && method === 'POST') return json(pull(7), 201)
        if (path.endsWith('/labels')) return json([], 200)
        return unexpected()
      },
      () =>
        makePrDriver('github', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1-do-the-thing',
          base: 'main',
          remote: 'origin',
          title: 'Do the thing',
          body: 'Task: am-1',
          labels: amagiLabels('bug'),
        }),
    )

    expect(calls.find((c) => c.includes('push'))).toEqual([
      'git',
      'push',
      '-u',
      '--force-with-lease=refs/heads/amagi/am-1-do-the-thing:',
      'origin',
      'amagi/am-1-do-the-thing',
    ])
    expect(invocations.find((c) => c.cmd.includes('push'))?.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:ghp_abc@github.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@github.com:',
    })
    expect(writes).toContainEqual([
      'POST',
      'repos/owner/repo/pulls',
      {
        title: 'Do the thing',
        body: 'Task: am-1',
        head: 'amagi/am-1-do-the-thing',
        base: 'main',
      },
    ])
    expect(writes).toContainEqual([
      'POST',
      'repos/owner/repo/issues/7/labels',
      { labels: ['amagi', 'amagi/bug'] },
    ])
    expect(pr).toEqual({ number: 7, url: 'https://github.com/owner/repo/pull/7' })
  })

  test('overwrites a stale remote branch no open pr uses, pinned to its sha', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('get-url')
        ? ok('git@github.com:owner/repo.git')
        : c.includes('ls-remote')
          ? ok('83213b1\trefs/heads/amagi/am-1-do-the-thing\n')
          : undefined,
    )
    const pr = await withFetch(
      (path, method) => {
        if (
          path ===
          'repos/owner/repo/pulls?state=open&head=owner%3Aamagi%2Fam-1-do-the-thing&per_page=100&page=1'
        ) {
          return json([])
        }
        if (path === 'repos/owner/repo/pulls' && method === 'POST') return json(pull(8), 201)
        if (path.endsWith('/labels')) return json([], 200)
        return unexpected()
      },
      () =>
        makePrDriver('github', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1-do-the-thing',
          base: 'main',
          remote: 'origin',
          title: 't',
          body: 'b',
          labels: [],
        }),
    )

    expect(calls.find((c) => c.includes('push'))).toEqual([
      'git',
      'push',
      '-u',
      '--force-with-lease=refs/heads/amagi/am-1-do-the-thing:83213b1',
      'origin',
      'amagi/am-1-do-the-thing',
    ])
    expect(pr.number).toBe(8)
  })

  test('refuses to overwrite a remote branch that backs an open pr', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('get-url')
        ? ok('git@github.com:owner/repo.git')
        : c.includes('ls-remote')
          ? ok('83213b1\trefs/heads/amagi/am-1\n')
          : undefined,
    )
    const create = withFetch(
      (path) =>
        path.startsWith('repos/owner/repo/pulls?state=open&head=')
          ? json([{ number: 36, html_url: 'https://github.com/owner/repo/pull/36' }])
          : unexpected(),
      () =>
        makePrDriver('github', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1',
          base: 'main',
          remote: 'origin',
          title: 't',
          body: 'b',
          labels: [],
        }),
    )

    await expect(create).rejects.toThrow('open pull request #36')
    expect(calls.find((c) => c.includes('push'))).toBeUndefined()
  })

  test('deletes a remote branch, tolerating one already gone', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('--delete')
        ? {
            exitCode: 1,
            stdout: '',
            stderr: "error: unable to delete 'amagi/am-1': remote ref does not exist",
          }
        : undefined,
    )
    await makePrDriver('github', 'origin', exec).deleteBranch('/repo', 'origin', 'amagi/am-1')
    expect(calls).toContainEqual(['git', 'push', 'origin', '--delete', 'amagi/am-1'])
  })

  test('surfaces any other branch deletion failure', async () => {
    const { exec } = fake((c) =>
      c.includes('--delete') ? { exitCode: 1, stdout: '', stderr: 'permission denied' } : undefined,
    )
    await expect(
      makePrDriver('github', 'origin', exec).deleteBranch('/repo', 'origin', 'amagi/am-1'),
    ).rejects.toThrow('permission denied')
  })

  test('creates each label and the outcome labels on demand before the pr', async () => {
    const { exec } = remote()
    const writes: Array<[string, string, unknown]> = []
    await withFetch(
      (path, method, body) => {
        if (method !== 'GET') writes.push([method, path, body])
        if (path === 'repos/owner/repo/labels') {
          // An existing label answers 422, which is not fatal.
          const name = (body as { name: string }).name
          return name === 'amagi' ? json({}, 422) : json({}, 201)
        }
        if (path === 'repos/owner/repo/pulls') return json(pull(7), 201)
        if (path.endsWith('/labels')) return json([], 200)
        return unexpected()
      },
      () =>
        makePrDriver('github', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1',
          base: 'main',
          remote: 'origin',
          title: 't',
          body: 'b',
          labels: ['amagi', 'amagi/chore'],
        }),
    )

    expect(writes.map(([, path]) => path)).toEqual([
      'repos/owner/repo/labels',
      'repos/owner/repo/labels',
      'repos/owner/repo/labels',
      'repos/owner/repo/labels',
      'repos/owner/repo/pulls',
      'repos/owner/repo/issues/7/labels',
    ])
    expect(writes.slice(0, 4).map(([, , body]) => (body as { name: string }).name)).toEqual([
      'amagi',
      'amagi/chore',
      'amagi/done',
      'amagi/rework',
    ])
  })

  test('reads pr label names from the api', async () => {
    const { exec } = remote()
    const names = await withFetch(
      () => json(pull(7, { labels: [{ name: 'amagi' }, { name: 'amagi/rework' }] })),
      () => makePrDriver('github', 'origin', exec).getPrLabels('/repo', 7),
    )
    expect(names).toEqual(['amagi', 'amagi/rework'])
  })

  test('resolves the remote pr state from the api', async () => {
    const { exec } = remote()
    const paths: string[] = []
    const state = await withFetch(
      (path) => {
        paths.push(path)
        return json(pull(7, { state: 'closed', merged: true }))
      },
      () => makePrDriver('github', 'origin', exec).getPr('/repo', 7),
    )

    expect(paths).toEqual(['repos/owner/repo/pulls/7'])
    expect(state).toBe('merged')
  })

  test('maps pr state: closed stays closed, anything else is open', async () => {
    const { exec } = remote()
    const stateOf = (over: Record<string, unknown>) =>
      withFetch(
        () => json(pull(7, over)),
        () => makePrDriver('github', 'origin', exec).getPr('/repo', 7),
      )

    expect(await stateOf({ state: 'closed' })).toBe('closed')
    expect(await stateOf({ state: 'open' })).toBe('open')
  })

  test('resolves the merge status from the api', async () => {
    const { exec } = remote()
    const statusOf = (over: Record<string, unknown>) =>
      withFetch(
        () => json(pull(7, over)),
        () => makePrDriver('github', 'origin', exec).getMergeStatus('/repo', 7),
      )

    expect(await statusOf({ mergeable: false, mergeable_state: 'dirty' })).toBe('conflicted')
    expect(await statusOf({ mergeable: true, mergeable_state: 'clean' })).toBe('mergeable')
  })

  test('reports unknown once GitHub is still computing after the retries', async () => {
    const { exec } = remote()
    let reads = 0
    const status = await withFetch(
      () => {
        reads++
        return json(pull(7, { mergeable: null, mergeable_state: 'unknown' }))
      },
      () => makePrDriver('github', 'origin', exec).getMergeStatus('/repo', 7),
    )

    expect(status).toBe('unknown')
    expect(reads).toBe(5)
  }, 10_000)

  test('collects conversation, review, and inline comments from the api', async () => {
    const { exec } = remote()
    const comments = await withFetch(
      (path) => {
        if (path === 'repos/owner/repo/issues/7/comments?per_page=100&page=1') {
          return json([{ id: 1, user: { login: 'bob' }, body: 'hello' }])
        }
        if (path === 'repos/owner/repo/pulls/7/reviews?per_page=100&page=1') {
          return json([{ id: 2, user: { login: 'bob' }, body: '@chise-maru this is wrong' }])
        }
        if (path === 'repos/owner/repo/pulls/7/comments?per_page=100&page=1') {
          return json([{ id: 3, user: { login: 'bob' }, body: 'remove this file' }])
        }
        return unexpected()
      },
      () => makePrDriver('github', 'origin', exec).listComments('/repo', 7),
    )

    expect(comments).toEqual([
      { id: '1', user: 'bob', body: 'hello' },
      { id: '2', user: 'bob', body: '@chise-maru this is wrong' },
      { id: '3', user: 'bob', body: 'remove this file' },
    ])
  })

  test('posts a comment to the pr conversation', async () => {
    const { exec } = remote()
    const writes: Array<[string, string, unknown]> = []
    await withFetch(
      (path, method, body) => {
        writes.push([method, path, body])
        return json({}, 201)
      },
      () => makePrDriver('github', 'origin', exec).postComment('/repo', 7, 'explanation'),
    )

    expect(writes).toEqual([
      ['POST', 'repos/owner/repo/issues/7/comments', { body: 'explanation' }],
    ])
  })

  test('closes the pr with the reason as the closing comment', async () => {
    const { exec } = remote()
    const writes: Array<[string, string, unknown]> = []
    await withFetch(
      (path, method, body) => {
        writes.push([method, path, body])
        return json({}, 200)
      },
      () => makePrDriver('github', 'origin', exec).closePr('/repo', 7, 'pointless'),
    )

    expect(writes).toEqual([
      ['POST', 'repos/owner/repo/issues/7/comments', { body: 'pointless' }],
      ['PATCH', 'repos/owner/repo/pulls/7', { state: 'closed' }],
    ])
  })

  test('lists open PRs, reading each one singly for its mergeability', async () => {
    const { exec } = remote()
    const reads: string[] = []
    const prs = await withFetch(
      (path) => {
        reads.push(path)
        if (path === 'repos/owner/repo/pulls?state=open&per_page=100&page=1') {
          return json([{ number: 7 }, { number: 8 }])
        }
        if (path === 'repos/owner/repo/pulls/7') return json(pull(7))
        if (path === 'repos/owner/repo/pulls/8') {
          return json(pull(8, { head: { ref: 'amagi/am-2', sha: 'cafe' } }))
        }
        return unexpected()
      },
      () => makePrDriver('github', 'origin', exec).listOpenPrs('/repo'),
    )

    expect(reads).toEqual([
      'repos/owner/repo/pulls?state=open&per_page=100&page=1',
      'repos/owner/repo/pulls/7',
      'repos/owner/repo/pulls/8',
    ])
    expect(prs).toEqual([
      prInfo(),
      prInfo({
        number: 8,
        url: 'https://github.com/owner/repo/pull/8',
        headRefName: 'amagi/am-2',
        headRefOid: 'cafe',
      }),
    ])
  })

  test('resolves a merge status by retrying while GitHub still computes it', async () => {
    const { exec } = remote()
    let reads = 0
    const status = await withFetch(
      () => {
        reads++
        return json(
          reads === 1 ? pull(7, { mergeable: null, mergeable_state: 'unknown' }) : pull(7),
        )
      },
      () => makePrDriver('github', 'origin', exec).getMergeStatus('/repo', 7),
    )

    expect(status).toBe('mergeable')
    expect(reads).toBe(2)
  })

  test('reads base and head shas and changed files from the api', async () => {
    const { exec } = remote()
    const changes = await withFetch(
      (path) => {
        if (path === 'repos/owner/repo/pulls/7') {
          return json(
            pull(7, {
              base: { ref: 'main', sha: 'base-sha' },
              head: { ref: 'amagi/am-1-do-the-thing', sha: 'head-sha' },
              changed_files: 140,
            }),
          )
        }
        if (path === 'repos/owner/repo/pulls/7/files?per_page=100') {
          return json([{ filename: 'src/a.ts' }, { filename: 'src/b.ts' }])
        }
        return unexpected()
      },
      () => makePrDriver('github', 'origin', exec).getPrChanges('/repo', 7),
    )

    expect(changes).toEqual({
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['src/a.ts', 'src/b.ts'],
      fileCount: 140,
    })
  })

  test('fetches the pr diff with the diff media type', async () => {
    const { exec } = remote()
    const accepts: string[] = []
    const diff = await withFetch(
      (path, _method, _body, headers) => {
        accepts.push(headers?.get('accept') ?? '')
        return path === 'repos/owner/repo/pulls/7'
          ? new Response('diff --git a/x b/x\n')
          : unexpected()
      },
      () => makePrDriver('github', 'origin', exec).getPrDiff('/repo', 7),
    )

    expect(accepts).toEqual(['application/vnd.github.diff'])
    expect(diff).toBe('diff --git a/x b/x\n')
  })

  test('adds and removes a label on an existing pr', async () => {
    const { exec } = remote()
    const writes: Array<[string, string, unknown]> = []
    await withFetch(
      (path, method, body) => {
        writes.push([method, path, body])
        return method === 'DELETE' ? new Response(null, { status: 204 }) : json([], 200)
      },
      async () => {
        const driver = makePrDriver('github', 'origin', exec)
        await driver.addLabel('/repo', 7, 'amagi/needs-closing')
        await driver.removeLabel('/repo', 7, 'amagi/needs-closing')
      },
    )

    expect(writes).toEqual([
      ['POST', 'repos/owner/repo/issues/7/labels', { labels: ['amagi/needs-closing'] }],
      ['DELETE', 'repos/owner/repo/issues/7/labels/amagi%2Fneeds-closing', undefined],
    ])
  })

  test('removing a label already gone from the pr is not an error, any other failure is', async () => {
    const { exec } = remote()
    const remove = (status: number) =>
      withFetch(
        () => new Response('{"message":"Not Found"}', { status }),
        () => makePrDriver('github', 'origin', exec).removeLabel('/repo', 7, 'P2'),
      )

    await remove(404)
    await expect(remove(403)).rejects.toThrow(/403/)
  })

  test('throws a clear error without a token', async () => {
    delete process.env.GH_TOKEN
    const { exec } = remote()
    await expect(makePrDriver('github', 'origin', exec).listOpenPrs('/repo')).rejects.toThrow(
      /GH_TOKEN/,
    )
  })
})

describe('forgejoPr', () => {
  const remote = () =>
    fake((cmd) => (cmd.includes('get-url') ? ok('git@git.example.com:owner/repo.git') : undefined))

  test('pushes and creates the pr through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec, calls, invocations } = remote()
    const created: unknown[] = []
    await withFetch(
      (path, method, body) => {
        if (path === 'repos/owner/repo/labels?limit=50&page=1' && method === 'GET') {
          return new Response(JSON.stringify([{ id: 9, name: 'amagi' }]))
        }
        if (path.endsWith('/labels')) return new Response('{}', { status: 201 })
        if (path === 'repos/owner/repo/pulls' && method === 'POST') {
          created.push(body)
          return new Response(
            JSON.stringify({
              number: 3,
              html_url: 'https://git.example.com/owner/repo/pulls/3',
            }),
            { status: 201 },
          )
        }
        return new Response('[]', { status: 200 })
      },
      async () => {
        const pr = await makePrDriver('forgejo', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1',
          base: 'main',
          remote: 'origin',
          title: 'Do the thing',
          body: 'Task: am-1',
          labels: ['amagi'],
        })
        expect(pr).toEqual({ url: 'https://git.example.com/owner/repo/pulls/3', number: 3 })
      },
    )
    const push = calls.find((c) => c.includes('push'))
    expect(push).toEqual([
      'git',
      'push',
      '-u',
      '--force-with-lease=refs/heads/amagi/am-1:',
      'origin',
      'amagi/am-1',
    ])
    expect(invocations.find((c) => c.cmd.includes('push'))?.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:fj_tok@git.example.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@git.example.com:',
    })
    expect(created).toEqual([
      { head: 'amagi/am-1', base: 'main', title: 'Do the thing', body: 'Task: am-1', labels: [9] },
    ])
  })

  test('posts a comment through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec, calls } = remote()
    const posted: unknown[] = []
    await withFetch(
      (path, method, body) => {
        if (path === 'repos/owner/repo/issues/3/comments' && method === 'POST') posted.push(body)
        return new Response('{}', { status: 201 })
      },
      () => makePrDriver('forgejo', 'origin', exec).postComment('/wt', 3, 'explanation'),
    )

    expect(posted).toEqual([{ body: 'explanation' }])
    expect(calls.some((c) => c[0] === 'tea')).toBe(false)
  })

  test('resolves merged state from the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const state = await withFetch(
      (_path, _method) =>
        new Response(JSON.stringify({ state: 'closed', merged: true }), { status: 200 }),
      () => makePrDriver('forgejo', 'origin', exec).getPr('/wt', 3),
    )
    expect(state).toBe('merged')
  })

  test('lists open PRs across pages through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const pr = (number: number) => ({
      number,
      title: 'Do the thing',
      body: 'Task: am-1',
      html_url: `https://git.example.com/owner/repo/pulls/${number}`,
      head: { ref: 'amagi/am-1' },
      base: { ref: 'main' },
      mergeable: true,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: '2026-09-21T10:00:00Z',
    })
    const prs = await withFetch(
      (path) => {
        if (path === 'repos/owner/repo/pulls?state=open&limit=50&page=1') {
          return new Response(JSON.stringify(Array.from({ length: 50 }, (_, i) => pr(i + 1))), {
            headers: { 'x-total-count': '51' },
          })
        }
        if (path === 'repos/owner/repo/pulls?state=open&limit=50&page=2') {
          return new Response(JSON.stringify([pr(51)]), { headers: { 'x-total-count': '51' } })
        }
        return new Response('[]', { status: 500 })
      },
      () => makePrDriver('forgejo', 'origin', exec).listOpenPrs('/wt'),
    )

    expect(prs).toHaveLength(51)
    expect(prs[50]).toEqual({
      number: 51,
      title: 'Do the thing',
      body: 'Task: am-1',
      url: 'https://git.example.com/owner/repo/pulls/51',
      headRefName: 'amagi/am-1',
      baseRefName: 'main',
      headRefOid: null,
      createdAt: '2026-09-20T10:00:00Z',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      updatedAt: '2026-09-21T10:00:00Z',
      labels: [],
    })
  })

  test('reports a conflict only when mergeable is false and a local merge-tree agrees', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const status = async (pr: Record<string, unknown>, mergeTreeExit = 0) => {
      const { exec } = fake((cmd) => {
        if (cmd.includes('get-url')) return ok('git@git.example.com:owner/repo.git')
        if (cmd.includes('merge-tree')) return { exitCode: mergeTreeExit, stdout: '', stderr: '' }
        return undefined
      })
      return withFetch(
        () => new Response(JSON.stringify(pr)),
        () => makePrDriver('forgejo', 'origin', exec).getMergeStatus('/wt', 3),
      )
    }
    const shas = { head: { ref: 'amagi/am-1', sha: 'h1' }, base: { ref: 'main', sha: 'b1' } }
    expect(await status({ mergeable: true, ...shas })).toBe('mergeable')
    expect(await status({ mergeable: false, ...shas }, 1)).toBe('conflicted')
    expect(await status({ mergeable: false, ...shas })).toBe('unknown')
    expect(await status({ mergeable: false, draft: true, ...shas }, 1)).toBe('unknown')
    expect(await status({ mergeable: false, ...shas }, 128)).toBe('unknown')
  })

  test('fetches a base commit missing locally before the merge-tree verdict', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    let fetched = false
    const { exec, invocations } = fake((cmd) => {
      if (cmd.includes('get-url')) return ok('git@git.example.com:owner/repo.git')
      if (cmd.includes('cat-file')) return { exitCode: fetched ? 0 : 1, stdout: '', stderr: '' }
      if (cmd.includes('fetch')) {
        fetched = true
        return ok('')
      }
      if (cmd.includes('merge-tree')) {
        return fetched
          ? { exitCode: 1, stdout: '', stderr: '' }
          : { exitCode: 128, stdout: '', stderr: 'fatal: bad object b1' }
      }
      return undefined
    })
    const pr = {
      mergeable: false,
      head: { ref: 'amagi/am-1', sha: 'h1' },
      base: { ref: 'main', sha: 'b1' },
    }
    const status = await withFetch(
      () => new Response(JSON.stringify(pr)),
      () => makePrDriver('forgejo', 'origin', exec).getMergeStatus('/wt', 3),
    )
    expect(status).toBe('conflicted')
    const fetch = invocations.find((c) => c.cmd.includes('fetch'))
    expect(fetch?.cmd).toEqual(['git', 'fetch', '--no-tags', 'origin', 'refs/heads/main'])
    expect(fetch?.env?.GIT_CONFIG_VALUE_0).toBe('git@git.example.com:')
  })

  test('collects conversation, paged review, and per-review inline comments', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const review = (id: number, comments_count: number) => ({
      id,
      user: { login: 'rev' },
      body: '',
      comments_count,
    })
    const comments = await withFetch(
      (path) => {
        if (path === 'repos/owner/repo/issues/3/comments') {
          return new Response(JSON.stringify([{ id: 1, user: { login: 'op' }, body: 'hi' }]))
        }
        if (path === 'repos/owner/repo/pulls/3/reviews?limit=50&page=1') {
          return new Response(
            JSON.stringify(Array.from({ length: 50 }, (_, i) => review(i + 100, 0))),
          )
        }
        if (path === 'repos/owner/repo/pulls/3/reviews?limit=50&page=2') {
          return new Response(JSON.stringify([review(200, 1)]))
        }
        if (path === 'repos/owner/repo/pulls/3/reviews?limit=50&page=3') {
          return new Response('[]')
        }
        if (path === 'repos/owner/repo/pulls/3/reviews/200/comments') {
          return new Response(JSON.stringify([{ id: 9, user: { login: 'rev' }, body: 'nit' }]))
        }
        return new Response('not found', { status: 404 })
      },
      () => makePrDriver('forgejo', 'origin', exec).listComments('/wt', 3),
    )
    expect(comments).toHaveLength(53)
    expect(comments[0]).toEqual({ id: '1', user: 'op', body: 'hi' })
    expect(comments.at(-1)).toEqual({ id: '9', user: 'rev', body: 'nit' })
  })

  test('tolerates a missing comment endpoint but surfaces a server error', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const list = (status: number) =>
      withFetch(
        (path) =>
          path.startsWith('repos/owner/repo/issues/3/comments')
            ? new Response('[]')
            : new Response('boom', { status }),
        () => makePrDriver('forgejo', 'origin', exec).listComments('/wt', 3),
      )
    expect(await list(404)).toEqual([])
    await expect(list(500)).rejects.toThrow(/500/)
  })

  test('fetches the pr diff through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const diff = await withFetch(
      (path) =>
        path === 'repos/owner/repo/pulls/3.diff'
          ? new Response('diff --git a/x b/x\n', { status: 200 })
          : new Response('[]', { status: 200 }),
      () => makePrDriver('forgejo', 'origin', exec).getPrDiff('/wt', 3),
    )
    expect(diff).toBe('diff --git a/x b/x\n')
  })

  test('reads base and head shas and changed files through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const changes = await withFetch(
      (path) => {
        if (path === 'repos/owner/repo/pulls/3') {
          return new Response(
            JSON.stringify({ base: { sha: 'base-sha' }, head: { sha: 'head-sha' } }),
          )
        }
        if (path === 'repos/owner/repo/pulls/3/files?limit=100') {
          return new Response(JSON.stringify([{ filename: 'src/a.ts' }]), {
            headers: { 'x-total-count': '120' },
          })
        }
        return new Response('boom', { status: 500 })
      },
      () => makePrDriver('forgejo', 'origin', exec).getPrChanges('/wt', 3),
    )

    expect(changes).toEqual({
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['src/a.ts'],
      fileCount: 120,
    })
  })

  test('closes the pr through the forgejo api after posting the reason', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const writes: unknown[] = []
    await withFetch(
      (path, method, body) => {
        if (path === 'repos/owner/repo/issues/3/comments' && method === 'POST') {
          writes.push(body)
          return new Response('{}', { status: 201 })
        }
        if (path === 'repos/owner/repo/pulls/3' && method === 'PATCH') {
          writes.push(body)
          return new Response(JSON.stringify({ state: 'closed' }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
      () => makePrDriver('forgejo', 'origin', exec).closePr('/wt', 3, 'pointless'),
    )
    expect(writes).toEqual([{ body: 'pointless' }, { state: 'closed' }])
  })

  test('throws a clear error without a token', async () => {
    const { exec } = remote()
    await expect(
      withFetch(
        () => new Response('{}', { status: 200 }),
        () => makePrDriver('forgejo', 'origin', exec).postComment('/wt', 3, 'hi'),
      ),
    ).rejects.toThrow(/FORGEJO_TOKEN/)
  })

  test('adds and removes a label on an existing pull request', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const edits: unknown[] = []
    await withFetch(
      (path, method, body) => {
        // A server capped below our limit answers short pages that are not the last.
        if (path === 'repos/owner/repo/labels?limit=50&page=1' && method === 'GET') {
          return new Response(
            JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: i + 100, name: `l${i}` }))),
          )
        }
        if (path === 'repos/owner/repo/labels?limit=50&page=2' && method === 'GET') {
          return new Response(JSON.stringify([{ id: 5, name: 'amagi/needs-closing' }]))
        }
        if (path === 'repos/owner/repo/issues/3/labels' && method === 'POST') {
          edits.push(body)
          return new Response('{}', { status: 200 })
        }
        if (path === 'repos/owner/repo/issues/3/labels/5' && method === 'DELETE') {
          edits.push('deleted 5')
          return new Response(null, { status: 204 })
        }
        return new Response('{}', { status: 200 })
      },
      async () => {
        const driver = makePrDriver('forgejo', 'origin', exec)
        await driver.addLabel('/wt', 3, 'amagi/needs-closing')
        await driver.removeLabel('/wt', 3, 'amagi/needs-closing')
      },
    )
    expect(edits).toEqual([{ labels: [5] }, 'deleted 5'])
  })
})

describe('gitlabPr', () => {
  const mr = (over: Record<string, unknown> = {}) => ({
    iid: 7,
    title: 'Do the thing',
    description: 'Task: am-1',
    web_url: 'https://gitlab.example.com/owner/repo/-/merge_requests/7',
    source_branch: 'amagi/am-1-do-the-thing',
    target_branch: 'main',
    sha: 'deadbeef',
    has_conflicts: false,
    merge_status: 'can_be_merged',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-21T10:00:00Z',
    labels: ['amagi'],
    ...over,
  })

  const project = 'projects/owner%2Frepo'
  const remote = () =>
    fake((c) => (c.includes('get-url') ? ok('git@gitlab.com:owner/repo.git') : undefined))

  beforeEach(() => {
    process.env.GITLAB_TOKEN = 'glpat-abc'
  })

  test('pushes over the token rewrite and creates the merge request over the api', async () => {
    const { exec, calls, invocations } = remote()
    const bodies: unknown[] = []
    const pr = await withFetch(
      (path, method, body) => {
        if (path === `${project}/labels` && method === 'POST') {
          return new Response('{"message":"taken"}', { status: 409 })
        }
        if (path === `${project}/merge_requests` && method === 'POST') {
          bodies.push(body)
          return new Response(JSON.stringify(mr()), { status: 201 })
        }
        return new Response('[]')
      },
      () =>
        makePrDriver('gitlab', 'origin', exec).createPr({
          cwd: '/wt',
          branch: 'amagi/am-1-do-the-thing',
          base: 'main',
          remote: 'origin',
          title: 'Do the thing',
          body: 'Task: am-1',
          labels: amagiLabels('bug'),
        }),
    )

    expect(calls.find((c) => c.includes('push'))).toEqual([
      'git',
      'push',
      '-u',
      '--force-with-lease=refs/heads/amagi/am-1-do-the-thing:',
      'origin',
      'amagi/am-1-do-the-thing',
    ])
    expect(invocations.find((c) => c.cmd.includes('push'))?.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://x-access-token:glpat-abc@gitlab.com/.insteadOf',
      GIT_CONFIG_VALUE_0: 'git@gitlab.com:',
    })
    expect(bodies).toEqual([
      {
        source_branch: 'amagi/am-1-do-the-thing',
        target_branch: 'main',
        title: 'Do the thing',
        description: 'Task: am-1',
        labels: 'amagi,amagi/bug',
      },
    ])
    expect(pr).toEqual({ number: 7, url: mr().web_url })
  })

  test('uploads a file as multipart and answers its host-absolute url', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-upload-'))
    const file = join(dir, '01-demo.webm')
    writeFileSync(file, 'video')
    const requests: { url: string; init: RequestInit }[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      return new Response(
        JSON.stringify({
          url: '/uploads/abc/01-demo.webm',
          full_path: '/-/project/42/uploads/abc/01-demo.webm',
        }),
        { status: 201 },
      )
    }) as typeof fetch
    try {
      const url = await makePrDriver('gitlab', 'origin', remote().exec).uploadFile?.('/wt', file)
      expect(url).toBe('https://gitlab.com/-/project/42/uploads/abc/01-demo.webm')
      expect(requests[0]?.url).toBe(`https://gitlab.com/api/v4/${project}/uploads`)
      const form = requests[0]?.init.body as FormData
      expect((form.get('file') as File).name).toBe('01-demo.webm')
      expect(new Headers(requests[0]?.init.headers).get('content-type')).toBeNull()
    } finally {
      globalThis.fetch = original
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('lists open merge requests across pages in the shared shape', async () => {
    const first = Array.from({ length: 100 }, (_, i) => mr({ iid: i + 1 }))
    const paths: string[] = []
    const { exec } = remote()
    const prs = await withFetch(
      (path) => {
        paths.push(path)
        if (path.endsWith('&page=1')) {
          return new Response(JSON.stringify(first), { headers: { 'x-next-page': '2' } })
        }
        return new Response(JSON.stringify([mr({ iid: 101, has_conflicts: true })]), {
          headers: { 'x-next-page': '' },
        })
      },
      () => makePrDriver('gitlab', 'origin', exec).listOpenPrs('/repo'),
    )
    expect(prs).toHaveLength(101)
    expect(prs[0]).toEqual(prInfo({ number: 1, url: mr().web_url }))
    expect(prs[100]).toMatchObject({ number: 101, mergeable: 'CONFLICTING' })
    expect(paths).toEqual([
      `${project}/merge_requests?state=opened&with_merge_status_recheck=true&per_page=100&page=1`,
      `${project}/merge_requests?state=opened&with_merge_status_recheck=true&per_page=100&page=2`,
    ])
  })

  test('maps merge request state and merge status', async () => {
    const reply = { state: 'merged', has_conflicts: false, merge_status: 'checking' }
    const { exec } = remote()
    await withFetch(
      () => new Response(JSON.stringify(reply)),
      async () => {
        const driver = makePrDriver('gitlab', 'origin', exec)
        expect(await driver.getPr('/repo', 7)).toBe('merged')
        expect(await driver.getMergeStatus('/repo', 7)).toBe('unknown')
        reply.state = 'locked'
        reply.has_conflicts = true
        expect(await driver.getPr('/repo', 7)).toBe('closed')
        expect(await driver.getMergeStatus('/repo', 7)).toBe('conflicted')
      },
    )
  })

  test('reads modern GitLab merge status when legacy fields are absent', async () => {
    const reply = { detailed_merge_status: 'conflict', has_conflicts: false }
    const { exec } = remote()
    await withFetch(
      () => new Response(JSON.stringify(reply)),
      async () => {
        const driver = makePrDriver('gitlab', 'origin', exec)
        expect(await driver.getMergeStatus('/repo', 7)).toBe('conflicted')
        reply.detailed_merge_status = 'mergeable'
        expect(await driver.getMergeStatus('/repo', 7)).toBe('mergeable')
        reply.detailed_merge_status = 'checking'
        expect(await driver.getMergeStatus('/repo', 7)).toBe('unknown')
      },
    )
  })

  test('collects notes as comments, skipping system notes', async () => {
    const notes = [
      { id: 1, body: '@chise-maru explain', author: { username: 'mcpie' }, system: false },
      { id: 2, body: 'added 1 commit', author: { username: 'mcpie' }, system: true },
    ]
    const { exec } = remote()
    const comments = await withFetch(
      (path) => {
        expect(path).toBe(`${project}/merge_requests/7/notes?per_page=100&page=1`)
        return new Response(JSON.stringify(notes))
      },
      () => makePrDriver('gitlab', 'origin', exec).listComments('/repo', 7),
    )
    expect(comments).toEqual([{ id: '1', user: 'mcpie', body: '@chise-maru explain' }])
  })

  test('reads diff refs and changed files of a merge request', async () => {
    const { exec } = remote()
    const changes = await withFetch(
      (path) => {
        if (path === `${project}/merge_requests/7`) {
          return new Response(
            JSON.stringify(
              mr({
                diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha' },
                changes_count: '1000+',
              }),
            ),
          )
        }
        if (path === `${project}/merge_requests/7/diffs?per_page=100`) {
          return new Response(JSON.stringify([{ new_path: 'src/a.ts' }]))
        }
        return new Response('boom', { status: 500 })
      },
      () => makePrDriver('gitlab', 'origin', exec).getPrChanges('/repo', 7),
    )
    expect(changes).toEqual({
      baseSha: 'base-sha',
      headSha: 'head-sha',
      changedFiles: ['src/a.ts'],
      fileCount: 1000,
    })
  })

  test('fetches the raw diff of a merge request', async () => {
    const { exec } = remote()
    const diff = await withFetch(
      (path) =>
        path === `${project}/merge_requests/7/raw_diffs`
          ? new Response('diff --git a/x b/x\n')
          : new Response('boom', { status: 500 }),
      () => makePrDriver('gitlab', 'origin', exec).getPrDiff('/repo', 7),
    )
    expect(diff).toBe('diff --git a/x b/x\n')
  })

  test('closes with the reason as a note, and edits labels in place', async () => {
    const { exec } = remote()
    const writes: Array<[string, string, unknown]> = []
    await withFetch(
      (path, method, body) => {
        writes.push([method, path, body])
        return new Response('{}', { status: 201 })
      },
      async () => {
        const driver = makePrDriver('gitlab', 'origin', exec)
        await driver.closePr('/repo', 7, 'superseded')
        await driver.addLabel('/repo', 7, 'amagi/needs-closing')
        await driver.removeLabel('/repo', 7, 'P2')
      },
    )
    expect(writes).toEqual([
      ['POST', `${project}/merge_requests/7/notes`, { body: 'superseded' }],
      ['PUT', `${project}/merge_requests/7`, { state_event: 'close' }],
      ['PUT', `${project}/merge_requests/7`, { add_labels: 'amagi/needs-closing' }],
      ['PUT', `${project}/merge_requests/7`, { remove_labels: 'P2' }],
    ])
  })

  test('throws a clear error without a token', async () => {
    delete process.env.GITLAB_TOKEN
    const { exec } = remote()
    await expect(makePrDriver('gitlab', 'origin', exec).listOpenPrs('/repo')).rejects.toThrow(
      /GITLAB_TOKEN/,
    )
  })
})
