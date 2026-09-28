import { lintCommitMessage } from './commit-lint.ts'
import type { TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import type { PrBodyMeta } from './pr-body.ts'
import { commitMessage } from './prompt.ts'

/** Stages and commits a worktree, returning false when it has no changes. */
export async function stageAndCommit(
  run: Exec,
  task: Pick<TrackerTask, 'id' | 'title'>,
  cwd: string,
  summary: string,
  meta: PrBodyMeta,
): Promise<{ committed: false } | { committed: true; sha: string }> {
  const status = await run(['git', 'status', '--porcelain'], { cwd })
  if (status.stdout.trim() === '') return { committed: false }
  const message = commitMessage(task, summary, meta)
  const lint = lintCommitMessage(message)
  if (lint.length > 0) throw new Error(`malformed commit message: ${lint.join('; ')}`)
  await run(['git', 'add', '-A'], { cwd })
  const commit = await run(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
  }
  const sha = (await run(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
  return { committed: true, sha }
}
