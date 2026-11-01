import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec, execOk } from './exec.ts'
import type { SetupReport } from './worktree.ts'
import { WorktreePool } from './worktree-pool.ts'

describe('WorktreePool', () => {
  let repo: string
  let root: string
  let pool: WorktreePool
  const reports: SetupReport[] = []
  const started: string[] = []
  const take = (id = 'task-1') =>
    pool.take(
      id,
      'test',
      'main',
      'echo setup >> setup.log',
      (command) => started.push(command),
      (report) => reports.push(report),
    )
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'amagi-pool-repo-'))
    root = mkdtempSync(join(tmpdir(), 'amagi-pool-worktrees-'))
    await execOk(exec, ['git', 'init', '-q', '-b', 'main'], { cwd: repo })
    await execOk(exec, ['git', 'config', 'user.name', 'Test'], { cwd: repo })
    await execOk(exec, ['git', 'config', 'user.email', 'test@example.com'], { cwd: repo })
    writeFileSync(join(repo, '.gitignore'), 'setup.log\n')
    writeFileSync(join(repo, 'bun.lock'), 'first\n')
    await execOk(exec, ['git', 'add', '.'], { cwd: repo })
    await execOk(exec, ['git', 'commit', '-qm', 'initial'], { cwd: repo })
    pool = new WorktreePool({
      repoRoot: repo,
      worktreeRoot: root,
      baseBranch: 'main',
    })
    reports.length = 0
    started.length = 0
  })
  afterEach(() => {
    pool.stop()
    rmSync(repo, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })
  async function prepare() {
    await pool.refill(1, 'echo setup >> setup.log')
  }
  test('hands off setup and reports it, preserving existing branches', async () => {
    await prepare()
    await execOk(exec, ['git', 'branch', 'amagi/task-1-test'], { cwd: repo })
    expect(await take()).toBeNull()
    const claimed = await take('task-2')
    expect(claimed?.branch).toBe('amagi/task-2-test')
    expect(await Bun.file(join(claimed?.path ?? '', 'setup.log')).text()).toBe('setup\n')
    expect(started).toEqual(['echo setup >> setup.log'])
    expect(reports).toHaveLength(1)
    expect(reports[0]?.exitCode).toBe(0)
  })
  test('reruns setup when the lockfile changes', async () => {
    await prepare()
    writeFileSync(join(repo, 'bun.lock'), 'second\n')
    await execOk(exec, ['git', 'add', 'bun.lock'], { cwd: repo })
    await execOk(exec, ['git', 'commit', '-qm', 'update lock'], { cwd: repo })
    const claimed = await take()
    expect(await Bun.file(join(claimed?.path ?? '', 'setup.log')).text()).toBe('setup\nsetup\n')
    expect(reports).toHaveLength(1)
  })
  test('recovers an assigned worktree without resetting its branch or files', async () => {
    await prepare()
    const claimed = await take()
    if (!claimed) throw new Error('expected worktree')
    writeFileSync(join(claimed.path, 'progress.txt'), 'keep me')
    pool.stop()
    pool = new WorktreePool({ repoRoot: repo, worktreeRoot: root, baseBranch: 'main' })
    const recovered = await take()
    expect(recovered).toEqual(claimed)
    expect(await Bun.file(join(claimed.path, 'progress.txt')).text()).toBe('keep me')
    expect(await Bun.file(join(claimed.path, 'setup.log')).text()).toBe('setup\nsetup\n')
    pool.recorded(claimed.branch)
    expect(await take()).toBeNull()
  })
})
