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
})
