import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import type { WorktreeSpec } from './worktree.ts'

export async function removeWorktree(
  repoRoot: string,
  path: string,
  opts: { force?: boolean; exec?: Exec } = {},
): Promise<void> {
  const run = opts.exec ?? defaultExec
  const args = ['git', 'worktree', 'remove', path]
  if (opts.force) args.push('--force')
  await execOk(run, args, { cwd: repoRoot })
}

export async function listWorktrees(
  repoRoot: string,
  run: Exec = defaultExec,
): Promise<WorktreeSpec[]> {
  const out = await execOk(run, ['git', 'worktree', 'list', '--porcelain'], { cwd: repoRoot })
  const found: WorktreeSpec[] = []
  let path: string | null = null

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch ') && path !== null) {
      found.push({ path, branch: line.slice('branch refs/heads/'.length) })
      path = null
    } else if (line === '' && path !== null) {
      found.push({ path, branch: '' })
      path = null
    }
  }
  return found
}
