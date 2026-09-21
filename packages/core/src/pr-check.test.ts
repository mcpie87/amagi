import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerTask } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  isConflicting,
  listOpenPrs,
  type PrInfo,
  prepareConflictWorktree,
  prMergeStatus,
  pushConflictFix,
  resolvePrPriorities,
  syncPrPriorityLabel,
  taskIdFromPrBranch,
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
              { ...pr(), labels: [{ name: 'amagi' }, { name: 'P2' }] },
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
      'number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,updatedAt,labels',
    ])
    expect(prs).toHaveLength(2)
    expect(prs[0]).toMatchObject({ number: 7, headRefName: 'amagi/am-1-do-the-thing' })
    expect(prs[0]?.labels).toEqual(['amagi', 'P2'])
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

describe('taskIdFromPrBranch', () => {
  test('parses the task id out of an amagi branch', () => {
    expect(taskIdFromPrBranch('amagi/am-1-do-the-thing')).toBe('am-1')
    expect(taskIdFromPrBranch('amagi/am-19b.2-ask-cli-fallback')).toBe('am-19b.2')
    expect(taskIdFromPrBranch('amagi/bd-a1b2-add-sse-endpoint')).toBe('bd-a1b2')
  })

  test('returns null for branches that are not amagi PRs', () => {
    expect(taskIdFromPrBranch('main')).toBeNull()
    expect(taskIdFromPrBranch('feature/am-1-x')).toBeNull()
  })
})

describe('resolvePrPriorities', () => {
  const task = (over: Partial<TrackerTask> = {}): TrackerTask => ({
    id: 'am-1',
    title: 't',
    description: '',
    status: 'open',
    priority: null,
    type: null,
    url: null,
    ...over,
  })

  test('reads bead priority and defaults P4 when the bead has none', async () => {
    const out = await resolvePrPriorities(
      [
        pr({ number: 7, headRefName: 'amagi/am-1-do-the-thing' }),
        pr({ number: 8, headRefName: 'amagi/am-2-x' }),
      ],
      async (id) => (id === 'am-1' ? task({ priority: 1 }) : task({ priority: null })),
    )
    expect(out).toEqual([
      { number: 7, priority: 1, amagi: true, linked: true },
      { number: 8, priority: 4, amagi: true, linked: true },
    ])
  })

  test('treats closed or missing beads and external branches as unlinked P4', async () => {
    const out = await resolvePrPriorities(
      [
        pr({ number: 7, headRefName: 'amagi/am-1-do-the-thing' }),
        pr({ number: 8, headRefName: 'amagi/am-2-x' }),
        pr({ number: 9, headRefName: 'feature/foo' }),
      ],
      async (id) => (id === 'am-1' ? task({ status: 'closed', priority: 2 }) : null),
    )
    expect(out).toEqual([
      { number: 7, priority: 4, amagi: true, linked: false },
      { number: 8, priority: 4, amagi: true, linked: false },
      { number: 9, priority: 4, amagi: false, linked: false },
    ])
  })
})

describe('syncPrPriorityLabel', () => {
  test('removes stale P* labels and adds the current one', async () => {
    const { exec, calls } = fake(() => undefined)
    await syncPrPriorityLabel({
      cwd: '/repo',
      number: 7,
      labels: ['amagi', 'P1', 'P3'],
      priority: 2,
      exec,
    })

    expect(calls).toContainEqual([
      'gh',
      'pr',
      'edit',
      '7',
      '--remove-label',
      'P1',
      '--remove-label',
      'P3',
    ])
    expect(calls).toContainEqual(['gh', 'label', 'create', 'P2', '--force'])
    expect(calls).toContainEqual(['gh', 'pr', 'edit', '7', '--add-label', 'P2'])
  })

  test('leaves a matching label alone', async () => {
    const { exec, calls } = fake(() => undefined)
    await syncPrPriorityLabel({
      cwd: '/repo',
      number: 7,
      labels: ['amagi', 'P4'],
      priority: 4,
      exec,
    })

    expect(calls.some((c) => c.includes('edit'))).toBe(false)
    expect(calls.some((c) => c.includes('--add-label'))).toBe(false)
    expect(calls.some((c) => c.includes('label') && c.includes('create'))).toBe(false)
  })

  test('removes any P* label when the bead is unlinked', async () => {
    const { exec, calls } = fake(() => undefined)
    await syncPrPriorityLabel({
      cwd: '/repo',
      number: 7,
      labels: ['amagi', 'P2'],
      priority: null,
      exec,
    })

    expect(calls).toContainEqual(['gh', 'pr', 'edit', '7', '--remove-label', 'P2'])
    expect(calls.some((c) => c.includes('--add-label'))).toBe(false)
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
