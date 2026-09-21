import type { TrackerTask } from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { modelFooter } from './footer.ts'

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
export async function diffBase(run: Exec, cwd: string, base: string): Promise<string> {
  const remote = `origin/${base}`
  const r = await run(['git', 'rev-parse', '--verify', '--quiet', remote], { cwd })
  return r.exitCode === 0 ? remote : base
}

export async function changesSinceBase(run: Exec, cwd: string, base: string): Promise<PrChange[]> {
  const ref = await diffBase(run, cwd, base)
  const r = await run(['git', 'diff', '--numstat', `${ref}...HEAD`], { cwd })
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

/** Heading an agent appends to the task description to document a user-facing feature. */
const HOW_TO_USE_HEADING = /^###\s+How to use\s*$/m

/**
 * Splits a task description into its summary and an optional `### How to use`
 * section (agent-authored when the PR adds a user-facing feature). howToUse is
 * null when the description has no such heading.
 */
function splitDescription(description: string): { summary: string; howToUse: string | null } {
  const match = description.match(HOW_TO_USE_HEADING)
  if (match?.index === undefined) return { summary: description.trim(), howToUse: null }
  const summary = description.slice(0, match.index).trim()
  const howToUse = description.slice(match.index).replace(HOW_TO_USE_HEADING, '').trim()
  return { summary, howToUse: howToUse === '' ? null : howToUse }
}

/** File names and paths, e.g. `hello.txt` or `packages/core/pr-body.ts`. */
const FILE_REF = /[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}/g

/** Wraps file names and paths in backticks, leaving existing code spans alone. */
export function backtickFileRefs(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(FILE_REF, '`$&`')))
    .join('')
}

/** Provenance of the model run that produced the PR, for the body footer. */
export type PrBodyMeta = {
  harness: string
  model: string | null
  effort: string | null
}

/**
 * Key of the machine-readable trailer that links a PR back to its tracker
 * task, in the same spirit as a `Co-Authored-By:` git trailer: a plain
 * `key: value` line a regex can find regardless of how the surrounding
 * markdown evolves. branchName (worktree.ts) encodes the same id in the
 * branch name, but splitting it back out of a slug is ambiguous; the trailer
 * is unambiguous because the id is on its own line.
 */
export const TASK_TRAILER_KEY = 'amagi-task'

/** Reads the `amagi-task:` trailer back off a PR body, or null if absent. */
export function taskIdFromPrBody(body: string): string | null {
  const re = new RegExp(`^${TASK_TRAILER_KEY}:\\s*(\\S+)\\s*$`, 'm')
  return body.match(re)?.[1] ?? null
}

export function formatPrBody(
  task: TrackerTask,
  changes: readonly PrChange[],
  meta?: PrBodyMeta,
): string {
  const lines = [`## ✨ ${task.title}`, '', `**Task:** \`${task.id}\``]
  const { summary, howToUse } = splitDescription(task.description)
  if (summary !== '') lines.push('', '### 📝 Summary', '', backtickFileRefs(summary))
  if (howToUse !== null) lines.push('', '### 🚀 How to use', '', howToUse)
  if (changes.length > 0) {
    lines.push('', '### 🛠️ What changed', '')
    for (const change of changes) {
      const stat = Number.isFinite(change.additions)
        ? `+${change.additions} -${change.deletions}`
        : 'binary'
      lines.push(`- \`${change.path}\` ${stat}`)
    }
  }
  const footer = meta === undefined ? '' : modelFooter(meta.harness, meta.model, meta.effort)
  return `${lines.join('\n')}${footer}\n\n${TASK_TRAILER_KEY}: ${task.id}`
}
