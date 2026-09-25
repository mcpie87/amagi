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

/** Headings an agent appends to the task description to document the PR. */
const SECTION_HEADING = /^###\s+(How to use|Conclusion)\s*$/gm

function stripPreflightSection(text: string): string {
  const headings = [...text.matchAll(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map((m) => ({
    index: m.index ?? 0,
    level: m[1]?.length ?? 1,
    title: m[2]?.trim() ?? '',
  }))
  let result = ''
  let cursor = 0

  for (const [i, heading] of headings.entries()) {
    if (heading.index < cursor) continue
    if (!/^Pre-flight(?:\s+\([^\r\n]*\))?$/i.test(heading.title)) continue
    result += text.slice(cursor, heading.index)
    const next = headings.slice(i + 1).find((candidate) => candidate.level <= heading.level)
    cursor = next?.index ?? text.length
  }

  return result + text.slice(cursor)
}

/**
 * Splits a task description into its summary and any agent-authored sections:
 * `### How to use` (optional, when the PR adds a user-facing feature) and
 * `### Conclusion` (mandatory, written after the work against the real diff).
 * Both are null when the description has no such heading.
 */
function splitDescription(description: string): {
  summary: string
  howToUse: string | null
  conclusion: string | null
} {
  // The regex requires the group, so a matched row always has index and name.
  const headings = [...description.matchAll(SECTION_HEADING)].map((m) => ({
    index: m.index ?? 0,
    name: m[1] ?? '',
  }))
  let summary = description.trim()
  let howToUse: string | null = null
  let conclusion: string | null = null
  for (const [i, heading] of headings.entries()) {
    const start = heading.index
    const end = headings[i + 1]?.index ?? description.length
    const body = description.slice(start, end).replace(SECTION_HEADING, '').trim()
    if (heading.name === 'How to use') howToUse = body === '' ? null : body
    else conclusion = body === '' ? null : body
    if (i === 0) summary = description.slice(0, start).trim()
  }
  return { summary, howToUse, conclusion }
}

function renderSections(howToUse: string | null, conclusion: string | null): string {
  const parts: string[] = []
  if (howToUse !== null) parts.push(`### How to use\n\n${howToUse}`)
  if (conclusion !== null) parts.push(`### Conclusion\n\n${conclusion}`)
  return parts.join('\n\n')
}

/**
 * Moves the `### How to use` / `### Conclusion` sections the agent ended its
 * final message with into the task description, replacing any an earlier
 * attempt left there. Returns null when the summary carries neither; the
 * returned summary is the message with the sections cut off.
 */
export function withAgentSections(
  description: string,
  finalMessage: string | null | undefined,
): { description: string; summary: string } | null {
  if (finalMessage === null || finalMessage === undefined) return null
  const agent = splitDescription(finalMessage)
  if (agent.howToUse === null && agent.conclusion === null) return null
  const task = splitDescription(description)
  const sections = renderSections(agent.howToUse, agent.conclusion)
  return {
    description: task.summary === '' ? sections : `${task.summary}\n\n${sections}`,
    summary: agent.summary,
  }
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
 * Key of the visible trailer older amagi PR bodies ended with, still read so
 * those PRs keep resolving to their task.
 */
export const TASK_TRAILER_KEY = 'amagi-task'

/**
 * Reads the task id off a PR body: the `**Task:**` line formatPrBody opens
 * with, or the legacy `amagi-task:` trailer. branchName (worktree.ts) encodes
 * the same id in the branch name, but splitting it back out of a slug is
 * ambiguous; the id here sits alone in a code span, so it is not.
 */
export function taskIdFromPrBody(body: string): string | null {
  const taskLine = /^\*\*Task:\*\*\s*`([^`\s]+)`/m
  const trailer = new RegExp(`^${TASK_TRAILER_KEY}:\\s*(\\S+)\\s*$`, 'm')
  return body.match(taskLine)?.[1] ?? body.match(trailer)?.[1] ?? null
}

/**
 * The task's age as a relative-time stamp for the Task line. GitHub and
 * Forgejo render `<relative-time datetime>` as a live relative age; the
 * element's text content is the plain-date fallback when they do not.
 */
function createdAgo(createdAt: number | null | undefined): string | null {
  if (createdAt === null || createdAt === undefined || Number.isNaN(createdAt)) return null
  const iso = new Date(createdAt).toISOString()
  return `created <relative-time datetime="${iso}">${iso.slice(0, 10)}</relative-time>`
}

export function formatPrBody(
  task: TrackerTask,
  changes: readonly PrChange[],
  meta?: PrBodyMeta,
  /** The implementing run's final summary, used as the conclusion when the agent wrote none. */
  fallbackSummary?: string | null,
): string {
  const created = createdAgo(task.createdAt)
  const lines = [
    `## ✨ ${task.title}`,
    '',
    `**Task:** \`${task.id}\`${created === null ? '' : ` · ${created}`}`,
  ]
  const { summary: descriptionSummary, howToUse, conclusion } = splitDescription(task.description)
  const summary = stripPreflightSection(descriptionSummary).trim()
  const body = summary !== '' ? summary : (fallbackSummary?.trim() ?? '')
  lines.push('', '### 📝 Summary', '', backtickFileRefs(body))
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
  const conclusionBody = conclusion ?? fallbackSummary
  if (conclusionBody !== null && conclusionBody !== undefined && conclusionBody.trim() !== '') {
    lines.push('', '### 🧠 Conclusion', '', backtickFileRefs(conclusionBody))
  }
  const footer = meta === undefined ? '' : modelFooter(meta.harness, meta.model, meta.effort)
  return `${lines.join('\n')}${footer}`
}
