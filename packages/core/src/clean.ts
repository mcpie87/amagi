import { existsSync } from 'node:fs'
import { TERMINAL_STATES } from './events.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import type { Store } from './store/store.ts'
import { branchExists } from './worktree.ts'

export type CleanPlan = {
  taskId: string
  path: string
  branch: string | null
}

export type CleanOptions = {
  repoRoot: string
  dryRun?: boolean
  exec?: Exec
}

export type RemoveWorktreeOptions = {
  repoRoot: string
  path: string
  branch: string | null
  exec?: Exec
}

/**
 * Removes one task's worktree and branch (idempotent when the path or branch
 * is already gone) and records `worktree.removed` so the store projection
 * drops them. Shared by the terminal-task clean and the instant close action.
 */
export async function removeWorktree(
  store: Store,
  taskId: string,
  opts: RemoveWorktreeOptions,
): Promise<void> {
  const run = opts.exec ?? defaultExec
  if (existsSync(opts.path)) {
    const r = await run(['git', 'worktree', 'remove', '--force', opts.path], {
      cwd: opts.repoRoot,
    })
    if (r.exitCode !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim()}`)
  }
  if (opts.branch !== null && (await branchExists(run, opts.repoRoot, opts.branch))) {
    const r = await run(['git', 'branch', '-D', opts.branch], { cwd: opts.repoRoot })
    if (r.exitCode !== 0) throw new Error(`git branch -D failed: ${r.stderr.trim()}`)
  }
  store.append(taskId, { type: 'worktree.removed', path: opts.path })
}

/**
 * Removes the worktree and branch left behind by terminal tasks and returns
 * what was (or would be) removed. Dry run by default: it only reports, never
 * touches the filesystem or the store.
 */
export async function cleanTerminalWorktrees(
  store: Store,
  opts: CleanOptions,
): Promise<CleanPlan[]> {
  const plans: CleanPlan[] = []

  for (const task of store.tasks({ states: TERMINAL_STATES, limit: 10_000 })) {
    if (task.worktree === null) continue
    const plan: CleanPlan = { taskId: task.id, path: task.worktree, branch: task.branch }
    plans.push(plan)
    if (opts.dryRun) continue
    await removeWorktree(store, task.id, {
      repoRoot: opts.repoRoot,
      path: plan.path,
      branch: plan.branch,
      ...(opts.exec === undefined ? {} : { exec: opts.exec }),
    })
  }

  return plans
}
