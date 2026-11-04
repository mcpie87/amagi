import { lintCommitMessage } from './commit-lint.ts'
import type { TrackerTask } from './drivers/types.ts'
import { type Exec, execOk } from './exec.ts'
import type { PrBodyMeta } from './pr-body.ts'
import { commitMessage, withCommitFooter } from './prompt.ts'

/**
 * Stages and commits a worktree, returning false when it has no changes. An
 * agent-written message is used when it lints; otherwise `[ticket] title`
 * with the summary as the body.
 */
export async function stageAndCommit(
  run: Exec,
  task: Pick<TrackerTask, 'id' | 'title' | 'labels'>,
  cwd: string,
  summary: string,
  meta: PrBodyMeta,
  authored: string | null = null,
): Promise<{ committed: false } | { committed: true; sha: string }> {
  const status = await execOk(run, ['git', 'status', '--porcelain'], { cwd })
  if (status.trim() === '') return { committed: false }
  const candidate = authored === null ? null : withCommitFooter(authored, meta)
  const message =
    candidate !== null && lintCommitMessage(candidate).length === 0
      ? candidate
      : commitMessage(task, summary, meta)
  const lint = lintCommitMessage(message)
  if (lint.length > 0) throw new Error(`malformed commit message: ${lint.join('; ')}`)
  await execOk(run, ['git', 'add', '-A'], { cwd })
  const commit = await run(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
  }
  const sha = (await run(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
  return { committed: true, sha }
}
