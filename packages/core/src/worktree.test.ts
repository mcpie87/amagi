import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec, execOk } from './exec.ts'
import {
  branchName,
  createWorktree,
  listWorktrees,
  removeWorktree,
  slugify,
  worktreeDirName,
} from './worktree.ts'

describe('slugify', () => {
  test('kebabs and truncates to five words', () => {
    expect(slugify('Add an SSE endpoint to the dashboard server')).toBe('add-an-sse-endpoint-to')
  })

  test('strips punctuation without leaving separators behind', () => {
    expect(slugify('Fix: worktree/branch naming (again!)')).toBe('fix-worktree-branch-naming-again')
  })

  test('folds Polish diacritics to ascii', () => {
    expect(slugify('Popraw obsługę błędów sieci')).toBe('popraw-obsluge-bledow-sieci')
  })

  test('falls back rather than producing an empty slug', () => {
    expect(slugify('???')).toBe('task')
    expect(slugify('')).toBe('task')
  })

  test('branch and directory names embed the task id', () => {
    expect(branchName('bd-a1b2', 'Add SSE endpoint')).toBe('amagi/bd-a1b2-add-sse-endpoint')
    expect(worktreeDirName('amagi', 'bd-a1b2', 'Add SSE endpoint')).toBe(
      'amagi-bd-a1b2-add-sse-endpoint',
    )
  })
})

describe('createWorktree', () => {
  let repo: string
  let wtRoot: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'amagi-repo-'))
    wtRoot = mkdtempSync(join(tmpdir(), 'amagi-wt-'))
    await execOk(exec, ['git', 'init', '-q', '-b', 'main', '.'], { cwd: repo })
    await execOk(exec, ['git', 'config', 'user.name', 'Test'], { cwd: repo })
    await execOk(exec, ['git', 'config', 'user.email', 'test@example.com'], { cwd: repo })
    writeFileSync(join(repo, 'README.md'), '# test\n')
    await execOk(exec, ['git', 'add', '.'], { cwd: repo })
    await execOk(exec, ['git', 'commit', '-q', '-m', 'init'], { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  const create = (title = 'Add SSE endpoint') =>
    createWorktree({
      repoRoot: repo,
      repoName: 'amagi',
      taskId: 'bd-a1b2',
      title,
      baseBranch: 'main',
      worktreeRoot: wtRoot,
    })

  test('creates a branch and a checked out directory', async () => {
    const wt = await create()
    expect(wt.branch).toBe('amagi/bd-a1b2-add-sse-endpoint')
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true)
    expect((await listWorktrees(repo)).map((w) => w.branch)).toContain(wt.branch)
  })

  test('is idempotent so a crashed run can resume', async () => {
    const first = await create()
    writeFileSync(join(first.path, 'progress.txt'), 'half done\n')
    const second = await create()
    expect(second).toEqual(first)
    expect(existsSync(join(first.path, 'progress.txt'))).toBe(true)
  })

  test('adopts an existing branch instead of failing', async () => {
    await execOk(exec, ['git', 'branch', 'amagi/bd-a1b2-add-sse-endpoint'], { cwd: repo })
    const wt = await create()
    expect(existsSync(wt.path)).toBe(true)
  })

  test('re-adds after the worktree dir is wiped and prunes the stale registration', async () => {
    const first = await create()
    rmSync(first.path, { recursive: true, force: true })
    const second = await create()
    expect(second).toEqual(first)
    expect(existsSync(first.path)).toBe(true)
    expect((await listWorktrees(repo)).map((w) => w.path)).toContain(first.path)
  })

  test('runs the setup command inside the worktree, not the repo', async () => {
    const wt = await createWorktree({
      repoRoot: repo,
      repoName: 'amagi',
      taskId: 'bd-a1b2',
      title: 'Add SSE endpoint',
      baseBranch: 'main',
      worktreeRoot: wtRoot,
      setupCmd: 'pwd > where.txt',
    })
    const where = await Bun.file(join(wt.path, 'where.txt')).text()
    expect(where.trim()).toContain('bd-a1b2')
    expect(existsSync(join(repo, 'where.txt'))).toBe(false)
  })

  test('a failing setup command is not swallowed', async () => {
    expect(
      createWorktree({
        repoRoot: repo,
        repoName: 'amagi',
        taskId: 'bd-a1b2',
        title: 'Add SSE endpoint',
        baseBranch: 'main',
        worktreeRoot: wtRoot,
        setupCmd: 'exit 3',
      }),
    ).rejects.toThrow()
  })

  test('removal detaches the worktree', async () => {
    const wt = await create()
    await removeWorktree(repo, wt.path, { force: true })
    expect(existsSync(wt.path)).toBe(false)
    expect((await listWorktrees(repo)).map((w) => w.path)).not.toContain(wt.path)
  })

  describe('persona', () => {
    let home: string
    const savedXdg = process.env.XDG_CONFIG_HOME

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'amagi-home-'))
      process.env.XDG_CONFIG_HOME = home
      const dir = join(home, 'git', 'personas')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'agent.gitconfig'),
        '[user]\n  name = Chise\n  email = chise@example.com\n',
      )
    })

    afterEach(() => {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
      rmSync(home, { recursive: true, force: true })
    })

    test('scopes the persona to the worktree, leaving the repo identity alone', async () => {
      const wt = await createWorktree({
        repoRoot: repo,
        repoName: 'amagi',
        taskId: 'bd-a1b2',
        title: 'Add SSE endpoint',
        baseBranch: 'main',
        worktreeRoot: wtRoot,
        persona: 'agent',
      })
      writeFileSync(join(wt.path, 'work.txt'), 'x\n')
      await execOk(exec, ['git', 'add', '-A'], { cwd: wt.path })
      await execOk(exec, ['git', 'commit', '-q', '-m', 'work'], { cwd: wt.path })
      expect(
        (await exec(['git', 'log', '-1', '--format=%an <%ae>'], { cwd: wt.path })).stdout.trim(),
      ).toBe('Chise <chise@example.com>')
      expect(
        (await exec(['git', 'log', '-1', '--format=%an <%ae>'], { cwd: repo })).stdout.trim(),
      ).toBe('Test <test@example.com>')
    })

    test('a missing persona fails loudly', async () => {
      expect(
        createWorktree({
          repoRoot: repo,
          repoName: 'amagi',
          taskId: 'bd-a1b2',
          title: 'Add SSE endpoint',
          baseBranch: 'main',
          worktreeRoot: wtRoot,
          persona: 'nobody',
        }),
      ).rejects.toThrow(/persona not found/)
    })
  })
})
