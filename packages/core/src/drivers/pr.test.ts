import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../exec.ts'
import { gitTokenConfig, makePrDriver } from './pr.ts'

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
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

describe('gitTokenConfig', () => {
  test('is empty without a token so git keeps the ssh remote', () => {
    expect(gitTokenConfig()).toEqual([])
  })

  test('rewrites the ssh remote to an https token url', () => {
    process.env.GH_TOKEN = 'ghp_abc'
    const [flag, cfg] = gitTokenConfig()
    expect(flag).toBe('-c')
    expect(cfg).toContain('x-access-token:ghp_abc')
    expect(cfg).toContain('insteadOf=git@github.com:')
  })
})

describe('githubPr', () => {
  test('pushes over the token rewrite and creates the pr with the title', async () => {
    process.env.GH_TOKEN = 'ghp_abc'
    const { exec, calls } = fake((c) =>
      c.includes('create') && c.includes('pr') ? ok('https://github.com/x/y/pull/7\n') : undefined,
    )
    const pr = await makePrDriver('github', exec).createPr({
      cwd: '/wt',
      branch: 'amagi/am-1-do-the-thing',
      base: 'main',
      remote: 'origin',
      title: 'Do the thing',
      body: 'Task: am-1',
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
    ])
    expect(calls).toContainEqual(['<stdin>', 'Task: am-1'])
    expect(pr).toEqual({ number: 7, url: 'https://github.com/x/y/pull/7' })
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
})
