import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../exec.ts'
import { gitTokenConfig } from './forge-cred.ts'
import { amagiLabels, makePrDriver } from './pr.ts'

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

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.FORGEJO_TOKEN
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.FORGEJO_TOKEN
})

describe('gitTokenConfig', () => {
  const remote = (url: string): { exec: Exec; calls: Call[] } =>
    fake((c) => (c.includes('get-url') ? ok(url) : undefined))

  test('is empty without a token so git keeps the ssh remote', async () => {
    expect(
      await gitTokenConfig(remote('git@github.com:x/y.git').exec, '/repo', 'origin', null),
    ).toEqual([])
  })

  test('rewrites the remote to an https token url', async () => {
    const { exec, calls } = remote('git@github.com:mcpie87/amagi.git')
    const [flag, cfg] = await gitTokenConfig(exec, '/repo', 'origin', 'ghp_abc')
    expect(flag).toBe('-c')
    expect(cfg).toBe('url.https://x-access-token:ghp_abc@github.com/.insteadOf=git@github.com:')
    expect(calls[0]).toEqual(['git', 'remote', 'get-url', 'origin'])
  })

  test('is empty when the remote cannot be parsed', async () => {
    expect(await gitTokenConfig(remote('not-a-remote').exec, '/repo', 'origin', 'tok')).toEqual([])
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
  test('pushes over the token rewrite and creates the pr with the title', async () => {
    process.env.GH_TOKEN = 'ghp_abc'
    const { exec, calls } = fake((c) => {
      if (c.includes('get-url')) return ok('git@github.com:mcpie87/amagi.git')
      if (c.includes('create') && c.includes('pr')) return ok('https://github.com/x/y/pull/7\n')
      return undefined
    })
    const pr = await makePrDriver('github', exec).createPr({
      cwd: '/wt',
      branch: 'amagi/am-1-do-the-thing',
      base: 'main',
      remote: 'origin',
      title: 'Do the thing',
      body: 'Task: am-1',
      labels: amagiLabels('bug'),
    })

    const push = calls.find((c) => c.includes('push'))
    expect(push).toEqual([
      'git',
      '-c',
      'url.https://x-access-token:ghp_abc@github.com/.insteadOf=git@github.com:',
      'push',
      '-u',
      'origin',
      'amagi/am-1-do-the-thing',
    ])
    expect(calls.find((c) => c.includes('create') && c.includes('pr'))).toEqual([
      'gh',
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'amagi/am-1-do-the-thing',
      '--title',
      'Do the thing',
      '--body-file',
      '-',
      '--label',
      'amagi',
      '--label',
      'amagi/bug',
    ])
    expect(calls).toContainEqual(['<stdin>', 'Task: am-1'])
    expect(pr).toEqual({ number: 7, url: 'https://github.com/x/y/pull/7' })
  })

  test('creates each label on demand before the pr', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('create') && c.includes('pr') ? ok('https://github.com/x/y/pull/7\n') : undefined,
    )
    await makePrDriver('github', exec).createPr({
      cwd: '/wt',
      branch: 'amagi/am-1',
      base: 'main',
      remote: 'origin',
      title: 't',
      body: 'b',
      labels: ['amagi', 'amagi/chore'],
    })

    const creates = calls.filter((c) => c.includes('label') && c.includes('create'))
    expect(creates).toEqual([
      ['gh', 'label', 'create', 'amagi', '--force'],
      ['gh', 'label', 'create', 'amagi/chore', '--force'],
    ])
  })

  test('resolves the remote pr state from gh', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('view') && c.includes('pr') ? ok('MERGED\n') : undefined,
    )
    const state = await makePrDriver('github', exec).getPr('/repo', 7)

    expect(calls).toContainEqual(['gh', 'pr', 'view', '7', '--json', 'state', '--jq', '.state'])
    expect(state).toBe('merged')
  })

  test('maps gh state: closed stays closed, anything else is open', async () => {
    const closed = fake((c) => (c.includes('view') ? ok('CLOSED\n') : undefined))
    const open = fake((c) => (c.includes('view') ? ok('OPEN\n') : undefined))

    expect(await makePrDriver('github', closed.exec).getPr('/repo', 7)).toBe('closed')
    expect(await makePrDriver('github', open.exec).getPr('/repo', 7)).toBe('open')
  })

  test('resolves the merge status from gh', async () => {
    const conflicting = fake((c) =>
      c.includes('view')
        ? ok('{"mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}\n')
        : undefined,
    )
    const mergeable = fake((c) =>
      c.includes('view') ? ok('{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}\n') : undefined,
    )
    const unknown = fake((c) =>
      c.includes('view') ? ok('{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}\n') : undefined,
    )

    expect(await makePrDriver('github', conflicting.exec).getMergeStatus('/repo', 7)).toBe(
      'conflicted',
    )
    expect(await makePrDriver('github', mergeable.exec).getMergeStatus('/repo', 7)).toBe(
      'mergeable',
    )
    expect(await makePrDriver('github', unknown.exec).getMergeStatus('/repo', 7)).toBe('unknown')
  })

  test('lists open prs from gh with their mergeability flags', async () => {
    const prs = [
      {
        number: 8,
        title: 'Do the thing',
        url: 'https://github.com/owner/repo/pull/8',
        headRefName: 'amagi/am-1',
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      },
      {
        number: 9,
        title: 'Conflicted work',
        url: 'https://github.com/owner/repo/pull/9',
        headRefName: 'amagi/am-2',
        baseRefName: 'main',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      },
    ]
    const { exec, calls } = fake((c) =>
      c.includes('pr') && c.includes('list') ? ok(`${JSON.stringify(prs)}\n`) : undefined,
    )
    const open = await makePrDriver('github', exec).listOpenPrs('/repo')

    expect(calls).toContainEqual([
      'gh',
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus',
    ])
    expect(open).toEqual(prs)
  })

  test('collects conversation, review, and inline comments from the api', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('repo') && c.includes('view') && c.includes('nameWithOwner')) {
        return ok('owner/repo\n')
      }
      if (c[2] === 'repos/owner/repo/issues/7/comments') {
        return ok('{"id":"1","user":"bob","body":"hello"}\n')
      }
      if (c[2] === 'repos/owner/repo/pulls/7/reviews') {
        return ok('{"id":"2","user":"bob","body":"@chise-maru this is wrong"}\n')
      }
      if (c[2] === 'repos/owner/repo/pulls/7/comments') {
        return ok('{"id":"3","user":"bob","body":"remove this file"}\n')
      }
      return undefined
    })
    const comments = await makePrDriver('github', exec).listComments('/repo', 7)

    expect(calls.some((c) => c[0] === 'gh' && c[1] === 'repo' && c.includes('nameWithOwner'))).toBe(
      true,
    )
    expect(comments).toEqual([
      { id: '1', user: 'bob', body: 'hello' },
      { id: '2', user: 'bob', body: '@chise-maru this is wrong' },
      { id: '3', user: 'bob', body: 'remove this file' },
    ])
  })

  test('posts a comment to the pr conversation', async () => {
    const { exec, calls } = fake(() => undefined)
    await makePrDriver('github', exec).postComment('/repo', 7, 'explanation')

    expect(calls).toContainEqual(['gh', 'pr', 'comment', '7', '--body-file', '-'])
    expect(calls).toContainEqual(['<stdin>', 'explanation'])
  })

  test('closes the pr with the reason as the closing comment', async () => {
    const { exec, calls } = fake(() => undefined)
    await makePrDriver('github', exec).closePr('/repo', 7, 'pointless')

    expect(calls).toContainEqual(['gh', 'pr', 'close', '7', '--comment', 'pointless'])
  })

  test('adds and removes a label on an existing pr', async () => {
    const { exec, calls } = fake(() => undefined)
    const driver = makePrDriver('github', exec)
    await driver.addLabel('/repo', 7, 'amagi/needs-closing')
    await driver.removeLabel('/repo', 7, 'amagi/needs-closing')

    expect(calls).toContainEqual(['gh', 'pr', 'edit', '7', '--add-label', 'amagi/needs-closing'])
    expect(calls).toContainEqual(['gh', 'pr', 'edit', '7', '--remove-label', 'amagi/needs-closing'])
  })
})

describe('forgejoPr', () => {
  const remote = (): { exec: Exec; calls: Call[] } => {
    const calls: Call[] = []
    const exec: Exec = async (cmd) => {
      calls.push(cmd)
      if (cmd.includes('get-url')) return ok('git@git.example.com:owner/repo.git')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exec, calls }
  }

  const withFetch = <T>(
    routes: (path: string, method: string, body?: unknown) => Response,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).split('/api/v1/')[1] ?? ''
      return routes(
        path,
        init?.method ?? 'GET',
        init?.body ? JSON.parse(String(init.body)) : undefined,
      )
    }) as typeof fetch
    return fn().finally(() => {
      globalThis.fetch = original
    })
  }

  test('pushes and creates the pr through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec, calls } = remote()
    await withFetch(
      (path, method) => {
        if (path.startsWith('repos/owner/repo/pulls') && method === 'POST') {
          return new Response(
            JSON.stringify({ index: 3, html_url: 'https://git.example.com/owner/repo/pulls/3' }),
            { status: 201 },
          )
        }
        if (path.endsWith('/labels')) return new Response('{}', { status: 201 })
        return new Response('[]', { status: 200 })
      },
      async () => {
        const pr = await makePrDriver('forgejo', exec).createPr({
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
    // the push went out over the tokenized remote
    expect(push?.join(' ')).toContain('x-access-token:fj_tok@git.example.com/')
    expect(push?.join(' ')).toContain('insteadOf=git@git.example.com:')
  })

  test('resolves merged state from the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const state = await withFetch(
      (_path, _method) =>
        new Response(JSON.stringify({ state: 'closed', merged: true }), { status: 200 }),
      () => makePrDriver('forgejo', exec).getPr('/wt', 3),
    )
    expect(state).toBe('merged')
  })

  test('resolves the merge status from the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const mergeable = await withFetch(
      () =>
        new Response(JSON.stringify({ mergeable: true, mergeable_state: 'clean' }), {
          status: 200,
        }),
      () => makePrDriver('forgejo', exec).getMergeStatus('/wt', 3),
    )
    const conflicted = await withFetch(
      () =>
        new Response(JSON.stringify({ mergeable: false, mergeable_state: 'has_conflicts' }), {
          status: 200,
        }),
      () => makePrDriver('forgejo', exec).getMergeStatus('/wt', 3),
    )
    expect(mergeable).toBe('mergeable')
    expect(conflicted).toBe('conflicted')
  })

  test('lists open prs from the forgejo api with normalized mergeability', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    const prs = await withFetch(
      (path) => {
        if (path.startsWith('repos/owner/repo/pulls?state=open')) {
          return new Response(
            JSON.stringify([
              {
                number: 5,
                title: 'Do the thing',
                html_url: 'https://git.example.com/owner/repo/pulls/5',
                head: { ref: 'amagi/am-1' },
                base: { ref: 'main' },
                mergeable: true,
                mergeable_state: 'clean',
              },
              {
                number: 6,
                title: 'Conflicted work',
                html_url: 'https://git.example.com/owner/repo/pulls/6',
                head: { ref: 'amagi/am-2' },
                base: { ref: 'main' },
                mergeable: false,
                mergeable_state: 'has_conflicts',
              },
            ]),
            { status: 200 },
          )
        }
        return new Response('[]', { status: 200 })
      },
      () => makePrDriver('forgejo', exec).listOpenPrs('/wt'),
    )

    expect(prs).toEqual([
      {
        number: 5,
        title: 'Do the thing',
        url: 'https://git.example.com/owner/repo/pulls/5',
        headRefName: 'amagi/am-1',
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      },
      {
        number: 6,
        title: 'Conflicted work',
        url: 'https://git.example.com/owner/repo/pulls/6',
        headRefName: 'amagi/am-2',
        baseRefName: 'main',
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      },
    ])
  })

  test('throws a clear error without a token', async () => {
    const { exec } = remote()
    await expect(
      withFetch(
        () => new Response('{}', { status: 200 }),
        () => makePrDriver('forgejo', exec).postComment('/wt', 3, 'hi'),
      ),
    ).rejects.toThrow(/FORGEJO_TOKEN/)
  })

  test('closes the pr through the forgejo api', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    let patched = false
    await withFetch(
      (path, method, body) => {
        if (path === 'repos/owner/repo/pulls/3' && method === 'PATCH') {
          patched = true
          expect(body).toEqual({ state: 'closed' })
          return new Response(JSON.stringify({ state: 'closed' }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
      () => makePrDriver('forgejo', exec).closePr('/wt', 3, 'pointless'),
    )
    expect(patched).toBe(true)
  })

  test('adds and removes a label on an existing pull request', async () => {
    process.env.FORGEJO_TOKEN = 'fj_tok'
    const { exec } = remote()
    await withFetch(
      (path, method) => {
        if (path === 'repos/owner/repo/labels' && method === 'GET') {
          return new Response(JSON.stringify([{ id: 5, name: 'amagi/needs-closing' }]), {
            status: 200,
          })
        }
        if (path === 'repos/owner/repo/issues/3/labels' && method === 'POST') {
          return new Response('{}', { status: 200 })
        }
        if (path === 'repos/owner/repo/issues/3/labels/5' && method === 'DELETE') {
          return new Response('', { status: 204 })
        }
        return new Response('{}', { status: 200 })
      },
      async () => {
        const driver = makePrDriver('forgejo', exec)
        await driver.addLabel('/wt', 3, 'amagi/needs-closing')
        await driver.removeLabel('/wt', 3, 'amagi/needs-closing')
      },
    )
  })
})
