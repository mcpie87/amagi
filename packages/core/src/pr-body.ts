import type { TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'

export type PrChange = {
  path: string
  /** NaN when the file is binary. */
  additions: number
  /** NaN when the file is binary. */
  deletions: number
}

/**
 * Resolves the ref the worktree branched from so the PR diff excludes base
 * changes: `origin/<base>` when a token fetch happened, else `<base>`.
 */
async function diffBase(run: Exec, cwd: string, base: string): Promise<string> {
  const remote = `origin/${base}`
  const r = await run(['git', 'rev-parse', '--verify', '--quiet', remote], { cwd })
  return r.exitCode === 0 ? remote : base
}

export async function changesSinceBase(
  run: Exec,
  cwd: string,
  base: string,
  workingTree = false,
): Promise<PrChange[]> {
  const ref = await diffBase(run, cwd, base)
  const range = workingTree ? ref : `${ref}...HEAD`
  const r = await run(['git', 'diff', '--numstat', range], { cwd })
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...rest] = line.split('\t')
      return {
        path: rest.join('\t'),
        additions: Number(additions),
        deletions: Number(deletions),
      }
    })
}

export function formatPrBody(task: TrackerTask, changes: readonly PrChange[]): string {
  const lines = [`## ✨ ${task.title}`, '', `**Task:** \`${task.id}\``]
  const description = task.description.trim()
  if (description !== '') lines.push('', '### 📝 Summary', '', description)
  if (changes.length > 0) {
    lines.push('', '### 🛠️ What changed', '')
    for (const change of changes) {
      const stat = Number.isFinite(change.additions)
        ? `+${change.additions} -${change.deletions}`
        : 'binary'
      lines.push(`- \`${change.path}\` ${stat}`)
    }
  }
  return lines.join('\n')
}
