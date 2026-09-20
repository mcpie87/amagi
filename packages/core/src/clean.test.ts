import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanTerminalWorktrees } from './clean.ts'
import { exec, execOk } from './exec.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'
import { createWorktree, listWorktrees, type WorktreeSpec } from './worktree.ts'

let repo: string
let wtRoot: string
let store: Store

async function makeWorktree(taskId: string, title: string): Promise<WorktreeSpec> {
  const wt = await createWorktree({
    repoRoot: repo,
    repoName: 'amagi',
    taskId,
    title,
    baseBranch: 'main',
    worktreeRoot: wtRoot,
  })
  writeFileSync(join(wt.path, 'junk.txt'), 'uncommitted\n')
  return wt
}

function recordTask(id: string, wt: WorktreeSpec, state?: string): void {
  store.append(id, { type: 'task.claimed', title: 'Test task', tracker: 'beads' })
  store.append(id, { type: 'worktree.created', path: wt.path, branch: wt.branch })
  if (state) store.append(id, { type: 'task.state', from: null, to: state as never })
}

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'amagi-repo-'))
  wtRoot = mkdtempSync(join(tmpdir(), 'amagi-wt-'))
  await execOk(exec, ['git', 'init', '-q', '-b', 'main', '.'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.name', 'Test'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.email', 'test@example.com'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# test\n')
  await execOk(exec, ['git', 'add', '.'], { cwd: repo })
  await execOk(exec, ['git', 'commit', '-q', '-m', 'init'], { cwd: repo })
  store = new Store(openDatabase(':memory:'))
})

afterEach(() => {
  store.close()
  rmSync(repo, { recursive: true, force: true })
  rmSync(wtRoot, { recursive: true, force: true })
})

describe('cleanTerminalWorktrees', () => {
  test('dry run reports terminal tasks but removes nothing', async () => {
    const done = await makeWorktree('bd-done', 'Add SSE endpoint')
    recordTask('bd-done', done, 'done')
    expect(existsSync(done.path)).toBe(true)

    const plans = await cleanTerminalWorktrees(store, { repoRoot: repo, dryRun: true })

    expect(plans).toEqual([{ taskId: 'bd-done', path: done.path, branch: done.branch }])
    expect(existsSync(done.path)).toBe(true)
    expect((await listWorktrees(repo)).map((w) => w.branch)).toContain(done.branch)
    expect(store.task('bd-done')?.worktree).toBe(done.path)
  })

  test('apply removes the worktree, its branch and clears the store', async () => {
    const done = await makeWorktree('bd-done', 'Add SSE endpoint')
    recordTask('bd-done', done, 'done')
    expect(existsSync(done.path)).toBe(true)

    const plans = await cleanTerminalWorktrees(store, { repoRoot: repo })

    expect(plans).toEqual([{ taskId: 'bd-done', path: done.path, branch: done.branch }])
    expect(existsSync(done.path)).toBe(false)
    expect((await listWorktrees(repo)).map((w) => w.branch)).not.toContain(done.branch)
    expect(store.task('bd-done')?.worktree).toBeNull()
    expect(store.task('bd-done')?.branch).toBeNull()
  })

  test('non-terminal tasks keep their worktree', async () => {
    const done = await makeWorktree('bd-done', 'Add SSE endpoint')
    const active = await makeWorktree('bd-live', 'WIP thing')
    recordTask('bd-done', done, 'done')
    recordTask('bd-live', active)

    const plans = await cleanTerminalWorktrees(store, { repoRoot: repo })

    expect(plans.map((p) => p.taskId)).toEqual(['bd-done'])
    expect(existsSync(active.path)).toBe(true)
    expect(store.task('bd-live')?.worktree).toBe(active.path)
  })

  test('a second run finds nothing left to clean', async () => {
    const done = await makeWorktree('bd-done', 'Add SSE endpoint')
    recordTask('bd-done', done, 'done')

    await cleanTerminalWorktrees(store, { repoRoot: repo })
    const again = await cleanTerminalWorktrees(store, { repoRoot: repo })

    expect(again).toEqual([])
  })

  test('a terminal task with no recorded worktree is skipped', async () => {
    store.append('bd-none', { type: 'task.claimed', title: 'no worktree', tracker: 'beads' })
    store.append('bd-none', { type: 'task.state', from: null, to: 'abandoned' })

    expect(await cleanTerminalWorktrees(store, { repoRoot: repo })).toEqual([])
  })
})
