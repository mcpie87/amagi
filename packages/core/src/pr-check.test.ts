import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerTask } from './drivers/types.ts'
import type { Exec, ExecResult } from './exec.ts'
import {
  fetchPullHeads,
  isConflicting,
  iterationLabel,
  iterationsFromLabels,
  listOpenPrs,
  mergeableToVerdict,
  mergeTreeVerdict,
  type PrInfo,
  prepareConflictWorktree,
  pushConflictFix,
  removePrLabel,
  resolvePrPriorities,
  stampIterationLabel,
  syncPrPriorityLabel,
  taskIdFromAmagiBranch,
  taskIdFromPrBranch,
} from './pr-check.ts'

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): {
  exec: Exec
  calls: Call[]
  inputs: unknown[]
} {
  const calls: Call[] = []
  const inputs: unknown[] = []
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd)
    if (cmd.includes('api') && opts?.stdin !== undefined)
      inputs.push(JSON.parse(String(opts.stdin)))
    if (cmd.includes('origin/main^{commit}'))
      return { exitCode: 0, stdout: 'base-oid\n', stderr: '' }
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls, inputs }
}

const addLabelsCall = (n: number): Call => [
  'gh',
  'api',
  '--method',
  'POST',
  `repos/{owner}/{repo}/issues/${n}/labels`,
  '--input',
  '-',
]

const removeLabelCall = (n: number, label: string): Call => [
  'gh',
  'api',
  '--method',
  'DELETE',
  `repos/{owner}/{repo}/issues/${n}/labels/${encodeURIComponent(label)}`,
]

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
  createdAt: '2026-09-20T10:00:00Z',
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
      'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,createdAt,updatedAt,labels',
    ])
    expect(prs).toHaveLength(2)
    expect(prs[0]).toMatchObject({ number: 7, headRefName: 'amagi/am-1-do-the-thing' })
    // gh reports labels as objects; listOpenPrs reduces them to names
    expect(prs[0]?.labels).toEqual(['amagi', 'P2'])
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

  test('flattens gh label objects into label names', async () => {
    const { exec } = fake((c) =>
      c.includes('list') && c.includes('pr')
        ? ok(
            JSON.stringify([
              { ...pr(), labels: [{ name: 'amagi' }, { name: 'amagi/iterations:2' }] },
            ]),
          )
        : undefined,
    )
    const prs = await listOpenPrs({ cwd: '/repo', exec })
    expect(prs[0]?.labels).toEqual(['amagi', 'amagi/iterations:2'])
  })
})

describe('iterations', () => {
  test('parses the amagi/iterations:N label, defaulting to 0', () => {
    expect(iterationsFromLabels([])).toBe(0)
    expect(iterationsFromLabels(undefined)).toBe(0)
    expect(iterationsFromLabels(['amagi', 'amagi/iterations:3'])).toBe(3)
    expect(iterationsFromLabels(['amagi/iterations:0'])).toBe(0)
    expect(iterationsFromLabels(['amagi/iterations:oops'])).toBe(0)
  })

  test('formats the iteration label', () => {
    expect(iterationLabel(4)).toBe('amagi/iterations:4')
  })

  test('taskIdFromAmagiBranch reads the task id from an amagi head branch', () => {
    expect(taskIdFromAmagiBranch('amagi/am-19b.2-ask-cli-fallback')).toBe('am-19b.2')
    expect(taskIdFromAmagiBranch('feature/foo')).toBeNull()
  })

  test('stamps the first iteration on an amagi PR with no prior label', async () => {
    const { exec, calls, inputs } = fake(() => undefined)
    const stamped = await stampIterationLabel({
      cwd: '/repo',
      pr: pr({ labels: ['amagi'] }),
      exec,
    })

    expect(stamped).toEqual({ taskId: 'am-1', iteration: 1 })
    expect(calls).toContainEqual(addLabelsCall(7))
    expect(inputs).toEqual([{ labels: ['amagi/iterations:1'] }])
  })

  test('stamps the next iteration and drops the stale label', async () => {
    const { exec, calls, inputs } = fake(() => undefined)
    const stamped = await stampIterationLabel({
      cwd: '/repo',
      pr: pr({ labels: ['amagi/iterations:2'] }),
      exec,
    })

    expect(stamped).toEqual({ taskId: 'am-1', iteration: 3 })
    expect(inputs).toEqual([{ labels: ['amagi/iterations:3'] }])
    expect(calls).toContainEqual(removeLabelCall(7, 'amagi/iterations:2'))
  })

  test('leaves non-amagi PRs untouched', async () => {
    const { exec, calls } = fake(() => undefined)
    const stamped = await stampIterationLabel({
      cwd: '/repo',
      pr: pr({ headRefName: 'feature/foo' }),
      exec,
    })

    expect(stamped).toBeNull()
    expect(calls).toEqual([])
  })
})

describe('mergeTreeVerdict', () => {
  test('runs merge-tree with the pinned config and maps the exit code', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('merge-tree') ? { exitCode: 1, stdout: '', stderr: '' } : undefined,
    )
    const verdict = await mergeTreeVerdict({
      repoRoot: '/repo',
      base: 'origin/main',
      head: 'refs/remotes/origin/pr/7/head',
      exec,
    })

    expect(verdict).toBe('conflict')
    expect(calls[0]).toEqual([
      'git',
      '-c',
      'merge.renames=true',
      '-c',
      'merge.conflictStyle=merge',
      '-c',
      'merge.directoryRenames=conflicts',
      'merge-tree',
      '--write-tree',
      '--quiet',
      'origin/main',
      'refs/remotes/origin/pr/7/head',
    ])
  })

  test('reports clean on exit 0', async () => {
    const { exec } = fake((c) => (c.includes('merge-tree') ? ok('') : undefined))
    expect(await mergeTreeVerdict({ repoRoot: '/repo', base: 'main', head: 'head', exec })).toBe(
      'clean',
    )
  })

  test('treats a missing ref (exit 1 with stderr) as an error, never a conflict', async () => {
    const { exec } = fake((c) =>
      c.includes('merge-tree')
        ? fail('merge-tree: nosuchref - not something we can merge')
        : undefined,
    )
    await expect(
      mergeTreeVerdict({ repoRoot: '/repo', base: 'main', head: 'nosuchref', exec }),
    ).rejects.toThrow('nosuchref')
  })
})

describe('mergeableToVerdict', () => {
  test('maps CONFLICTING and MERGEABLE 1:1 and UNKNOWN to a third bucket', () => {
    expect(mergeableToVerdict('CONFLICTING')).toBe('conflict')
    expect(mergeableToVerdict('MERGEABLE')).toBe('clean')
    expect(mergeableToVerdict('UNKNOWN')).toBe('unknown')
    expect(mergeableToVerdict('')).toBe('unknown')
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
    const { exec, calls, inputs } = fake(() => undefined)
    await syncPrPriorityLabel({
      cwd: '/repo',
      number: 7,
      labels: ['amagi', 'P1', 'P3'],
      priority: 2,
      exec,
    })

    expect(calls).toContainEqual(removeLabelCall(7, 'P1'))
    expect(calls).toContainEqual(removeLabelCall(7, 'P3'))
    expect(inputs).toEqual([{ labels: ['P2'] }])
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

    expect(calls).toEqual([])
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

    expect(calls).toEqual([removeLabelCall(7, 'P2')])
  })
})

describe('removePrLabel', () => {
  test('a label already gone from the PR is not an error, any other failure is', async () => {
    const gone = fake(() => fail('gh: Label does not exist (HTTP 404)'))
    await removePrLabel(gone.exec, '/repo', 7, 'P2')
    const denied = fake(() => fail('gh: Resource not accessible (HTTP 403)'))
    await expect(removePrLabel(denied.exec, '/repo', 7, 'P2')).rejects.toThrow(/HTTP 403/)
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
    expect(calls).toContainEqual([
      'git',
      'merge',
      '-m',
      "Merge remote-tracking branch 'origin/main'",
      'base-oid',
    ])
    expect(wt).toEqual({
      path: '/wt/amagi-pr-7',
      branch: 'amagi/pr-7-conflict',
      conflicted: true,
      baseOid: 'base-oid',
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
        baseOid: 'base-oid',
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
