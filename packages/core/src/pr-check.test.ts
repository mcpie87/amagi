import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from './exec.ts'
import {
  fetchPullHeads,
  isConflicting,
  listOpenPrs,
  type PrInfo,
  prepareConflictWorktree,
  prMergeStatus,
  pushConflictFix,
} from './pr-check.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): ExecResult => ({ exitCode: 1, stdout: '', stderr })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  body: '',
  url: 'https://github.com/mcpie87/amagi/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefOid: 'deadbeef',
  updatedAt: '2026-09-21T10:00:00Z',
  labels: [],
  ...over,
})

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
})

describe('isConflicting', () => {
  test('flags CONFLICTING or DIRTY against the base branch', () => {
    expect(isConflicting(pr(), 'main')).toBe(true)
    expect(isConflicting(pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), 'main')).toBe(
      false,
    )
    expect(isConflicting(pr({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }), 'main')).toBe(
      false,
    )
    expect(isConflicting(pr(), 'develop')).toBe(false)
  })
})

describe('listOpenPrs', () => {
  test('parses open PRs from gh pr list', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('list') && c.includes('pr')
        ? ok(
            JSON.stringify([
              { ...pr(), labels: [{ name: 'amagi' }, { name: 'amagi/bug' }] },
              pr({ number: 8, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
            ]),
          )
        : undefined,
    )
    const prs = await listOpenPrs({ cwd: '/repo', exec })

    expect(calls[0]).toEqual([
      'gh',
      'pr',
      'list',
      '--state',
      'open',
      '--json',
      'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,updatedAt,labels',
    ])
    expect(prs).toHaveLength(2)
    expect(prs[0]).toMatchObject({ number: 7, headRefName: 'amagi/am-1-do-the-thing' })
    // gh reports labels as objects; listOpenPrs reduces them to names
    expect(prs[0]?.labels).toEqual(['amagi', 'amagi/bug'])
    expect(prs[1]?.labels).toEqual([])
  })
})

describe('fetchPullHeads', () => {
  test('skips the fetch when no PR head moved', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('ls-remote') ? ok('deadbeef\trefs/pull/7/head\n') : undefined,
    )
    const result = await fetchPullHeads({
      repoRoot: '/repo',
      lastHeads: { 'refs/pull/7/head': 'deadbeef' },
      exec,
    })

    expect(result).toEqual({ fetched: false, heads: { 'refs/pull/7/head': 'deadbeef' } })
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'fetch')).toBe(false)
  })

  test('fetches all PR heads in one round trip when a head moved', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('ls-remote')
        ? ok('newsha\trefs/pull/7/head\ncafe12\trefs/pull/8/head\n')
        : undefined,
    )
    const result = await fetchPullHeads({
      repoRoot: '/repo',
      lastHeads: { 'refs/pull/7/head': 'deadbeef', 'refs/pull/8/head': 'cafe12' },
      exec,
    })

    expect(result.fetched).toBe(true)
    expect(calls).toContainEqual([
      'git',
      'fetch',
      '--prune',
      'origin',
      '+refs/pull/*/head:refs/remotes/origin/pr/*',
    ])
  })

  test('fetches when a PR head disappears so the mirror is pruned', async () => {
    const { exec } = fake((c) => (c.includes('ls-remote') ? ok('') : undefined))
    const result = await fetchPullHeads({
      repoRoot: '/repo',
      lastHeads: { 'refs/pull/7/head': 'deadbeef' },
      exec,
    })

    expect(result.fetched).toBe(true)
    expect(result.heads).toEqual({})
  })
})

describe('prMergeStatus', () => {
  test('retries while GitHub reports UNKNOWN, then returns the resolved state', async () => {
    const calls: Call[] = []
    let n = 0
    const exec: Exec = async (cmd) => {
      calls.push(cmd)
      n++
      if (n === 1) return ok(JSON.stringify({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))
      return ok(JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }))
    }

    const status = await prMergeStatus('/repo', 7, exec)

    expect(status).toEqual({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })
    expect(calls).toHaveLength(2)
  })
})

describe('prepareConflictWorktree', () => {
  test('fetches, adds a worktree off the PR head, and reports conflicts from the merge', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return fail('conflict')
      return undefined
    })
    const wt = await prepareConflictWorktree({
      repoRoot: '/repo',
      repoName: 'amagi',
      worktreeRoot: '/wt',
      baseBranch: 'main',
      pr: pr(),
      exec,
    })

    expect(calls.some((c) => c.includes('fetch') && c.includes('main'))).toBe(true)
    expect(calls.some((c) => c.includes('fetch') && c.includes('amagi/am-1-do-the-thing'))).toBe(
      true,
    )
    expect(calls).toContainEqual([
      'git',
      'worktree',
      'add',
      '-b',
      'amagi/pr-7-conflict',
      '/wt/amagi-pr-7',
      'origin/amagi/am-1-do-the-thing',
    ])
    expect(calls).toContainEqual(['git', 'merge', 'origin/main'])
    expect(wt).toEqual({
      path: '/wt/amagi-pr-7',
      branch: 'amagi/pr-7-conflict',
      conflicted: true,
    })
  })

  test('reports conflicted false when the base merges cleanly', async () => {
    const { exec } = fake((c) => {
      if (c.includes('rev-parse')) return fail('')
      if (c.includes('merge')) return ok('Already up to date')
      return undefined
    })
    const wt = await prepareConflictWorktree({
      repoRoot: '/repo',
      repoName: 'amagi',
      worktreeRoot: '/wt',
      baseBranch: 'main',
      pr: pr(),
      exec,
    })

    expect(wt.conflicted).toBe(false)
  })

  test('aborts a stale merge and resets a reused worktree to the PR head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-wt-'))
    const path = join(root, 'amagi-pr-7')
    mkdirSync(path, { recursive: true })
    try {
      const { exec, calls } = fake((c) => {
        if (c.join(' ').includes('merge --abort')) return ok('')
        if (c.join(' ').includes('reset --hard')) return ok('')
        if (c.includes('rev-parse')) return fail('')
        if (c.includes('merge')) return fail('conflict')
        return undefined
      })
      const wt = await prepareConflictWorktree({
        repoRoot: '/repo',
        repoName: 'amagi',
        worktreeRoot: root,
        baseBranch: 'main',
        pr: pr(),
        exec,
      })

      expect(calls).toContainEqual(['git', 'merge', '--abort'])
      expect(calls).toContainEqual(['git', 'reset', '--hard', 'origin/amagi/am-1-do-the-thing'])
      expect(wt).toEqual({
        path,
        branch: 'amagi/pr-7-conflict',
        conflicted: true,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('scopes the persona to the conflict worktree when configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amagi-home-'))
    const savedXdg = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = home
      const dir = join(home, 'git', 'personas')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'agent.gitconfig'),
        '[user]\n  name = Chise\n  email = chise@example.com\n',
      )
      const { exec, calls } = fake((c) => {
        if (c.includes('rev-parse')) return fail('')
        if (c.includes('merge')) return fail('conflict')
        return undefined
      })

      await prepareConflictWorktree({
        repoRoot: '/repo',
        repoName: 'amagi',
        worktreeRoot: '/wt',
        baseBranch: 'main',
        pr: pr(),
        persona: 'agent',
        exec,
      })

      expect(calls).toContainEqual(['git', 'config', 'extensions.worktreeConfig', 'true'])
      expect(calls).toContainEqual([
        'git',
        'config',
        '--worktree',
        'include.path',
        join(dir, 'agent.gitconfig'),
      ])
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('pushConflictFix', () => {
  test('pushes the local branch to the PR head ref', async () => {
    const { exec, calls } = fake(() => undefined)
    await pushConflictFix({
      cwd: '/wt/amagi-pr-7',
      branch: 'amagi/pr-7-conflict',
      headRef: 'amagi/am-1-do-the-thing',
      remote: 'origin',
      exec,
    })

    expect(calls).toContainEqual([
      'git',
      'push',
      'origin',
      'amagi/pr-7-conflict:refs/heads/amagi/am-1-do-the-thing',
    ])
  })
})
