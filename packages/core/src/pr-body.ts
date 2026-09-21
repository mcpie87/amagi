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

/** Existing inline code spans and fenced blocks, left untouched. */
const PROTECTED = /(```[\s\S]*?```|`[^`\n]+`)/g

/** A line that starts a shell command after a prompt marker. */
const PROMPT_LINE = /^(\s*[$>%]\s+)(.+?)\s*$/m

const FILE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|py|json|jsonl|md|toml|nix|lock|txt|png|jpe?g|gif|svg|webp|ico|css|scss|html|sh|zsh|bash|fish|yml|yaml|sql|go|rs|c|h|cpp|hpp|rb|php|mod|sum|db|env|cfg|conf|ini|log|dolt|dotx|pptx|docx'

const CODE_REF = new RegExp(
  [
    // file paths
    String.raw`[\w.-]+(?:/[\w.-]+)+`,
    // file names with a known extension
    String.raw`[\w.-]+\.(?:${FILE_EXTENSIONS})`,
    // dotted identifiers, e.g. Runner.drive
    String.raw`[A-Za-z]{2}\w*(\.[A-Za-z]{2}\w*)+`,
    // snake_case
    '[a-zA-Z]+(?:_[a-zA-Z0-9]+)+',
    // camelCase
    '[a-z]+[A-Z][a-zA-Z0-9]*',
    // kebab-case containing a digit (task/branch ids, versions)
    String.raw`(?=\S*\d)[a-z]+(?:-[a-z0-9]+)+`,
    // #issue / #PR references
    String.raw`#\d+`,
    // version numbers
    String.raw`\d+\.\d+(?:\.\d+)*`,
    // long-form CLI flags
    '--[a-z][a-z0-9-]*',
  ].join('|'),
  'g',
)

/**
 * Wraps code references (identifiers, file paths, commands) in backticks.
 * Existing inline code and fenced blocks are left untouched.
 */
export function backtickCodeRefs(text: string): string {
  const parts = text.split(PROTECTED)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part
        .replace(PROMPT_LINE, (_, pre: string, cmd: string) => `${pre}\`${cmd.trim()}\``)
        .replace(CODE_REF, '`$&`')
    })
    .join('')
}

/** Provenance of the model run that produced the PR, for the body footer. */
export type PrBodyMeta = {
  harness: string
  model: string | null
  effort: string | null
}

export function formatPrBody(
  task: TrackerTask,
  changes: readonly PrChange[],
  meta?: PrBodyMeta,
): string {
  const lines = [`## ✨ ${task.title}`, '', `**Task:** \`${task.id}\``]
  const { summary, howToUse } = splitDescription(task.description)
  if (summary !== '') lines.push('', '### 📝 Summary', '', backtickCodeRefs(summary))
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
  return lines.join('\n') + footer
}
