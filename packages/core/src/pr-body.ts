import type { TrackerTask } from './drivers/types.ts'
import type { CheckResult } from './events.ts'
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
 * changes: `<remote>/<base>` when a token fetch happened, else `<base>`.
 */
export async function diffBase(
  run: Exec,
  cwd: string,
  remote: string,
  base: string,
): Promise<string> {
  const tracking = `${remote}/${base}`
  const r = await run(['git', 'rev-parse', '--verify', '--quiet', tracking], { cwd })
  return r.exitCode === 0 ? tracking : base
}

export async function changesSinceBase(
  run: Exec,
  cwd: string,
  remote: string,
  base: string,
): Promise<PrChange[]> {
  const ref = await diffBase(run, cwd, remote, base)
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
const FILE_REF = /(?<![\w.-])[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,9}(?![\w])/g

/** Wraps file names and paths in backticks, leaving existing code spans alone. */
export function backtickFileRefs(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`|\]\([^)]*\)|&lt;[^\n]*?&gt;)/g)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(FILE_REF, '`$&`')))
    .join('')
}

function renderDescriptionMarkdown(text: string): string {
  return backtickFileRefs(text.replace(/</g, '&lt;').replace(/>/g, '&gt;')).replace(
    /(^|\n)( {0,3})(#{1,6})(?=[ \t])/g,
    (_match, lineStart, indent: string, hashes: string) => {
      const level = Math.min(6, hashes.length + 2)
      return `${lineStart}${indent}${'#'.repeat(level)}`
    },
  )
}

function normalizeWorktreeLinks(text: string): string {
  return text.replace(/\]\(([^)]*)\)/g, (link, destination: string) => {
    const worktreePath = destination.replaceAll('`', '').match(/(?:^|\/)worktrees\/[^/]+\/(.+)$/)
    return worktreePath === undefined || worktreePath === null ? link : `](${worktreePath[1]})`
  })
}

/** Provenance of the model run that produced the PR, for the body footer. */
export type PrBodyMeta = {
  harness: string
  model: string | null
  effort: string | null
}

export type PrReviewSummary = {
  unresolved: boolean
  unresolvedIds: readonly string[]
  unresolvedFindings: readonly {
    id: string
    severity: string
    title: string
    path: string
    line: number
    failureScenario: string
    reply: { outcome: 'fixed' | 'wont-fix'; reason: string } | null
  }[]
  followUps?: readonly {
    id: string
    title: string
    path: string
    line: number
    evidence: string
    failureScenario: string
    covers?: string
    proposalId?: string
    proposalUrl?: string | null
  }[]
  proposalCreationSupported?: boolean
  history: string
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
 * The task's creation time as a fixed UTC stamp for the Task line.
 */
function createdAgo(createdAt: number | null | undefined): string | null {
  if (createdAt === null || createdAt === undefined || Number.isNaN(createdAt)) return null
  const iso = new Date(createdAt).toISOString()
  return `created \`${iso.slice(0, 19).replace('T', ' ')} UTC\``
}

export function formatPrBody(
  task: TrackerTask,
  changes: readonly PrChange[],
  meta?: PrBodyMeta,
  /** The implementing run's final summary, used as the conclusion when the agent wrote none. */
  fallbackSummary?: string | null,
  review?: PrReviewSummary,
  verification?: readonly CheckResult[],
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
  lines.push('', '### 📝 Summary', '', renderDescriptionMarkdown(normalizeWorktreeLinks(body)))
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
    lines.push(
      '',
      '### 🧠 Conclusion',
      '',
      renderDescriptionMarkdown(normalizeWorktreeLinks(conclusionBody)),
    )
  }
  if (verification !== undefined) {
    lines.push(
      '',
      '### ✅ Verification',
      '',
      ...verification.map(
        (result) =>
          `- \`${result.command}\`: ${result.exitCode === 0 ? 'passed' : `failed (exit ${result.exitCode})`}`,
      ),
    )
  }
  if (review !== undefined) {
    lines.push('', '### 🔎 Review', '', review.history)
    const followUps = review.followUps ?? []
    const covered = followUps.filter((finding) => finding.covers !== undefined)
    if (followUps.length > 0) {
      lines.push('', '### Follow-up findings', '')
      if (review.proposalCreationSupported === false) {
        lines.push('This tracker cannot create issues, so these follow-ups are recorded here only.')
      }
      for (const finding of followUps) {
        const proposal =
          finding.proposalId === undefined
            ? finding.covers === undefined
              ? ''
              : `, covered by issue \`${finding.covers}\``
            : finding.proposalUrl === null || finding.proposalUrl === undefined
              ? `, proposed as \`${finding.proposalId}\``
              : `, proposed as [\`${finding.proposalId}\`](${finding.proposalUrl})`
        lines.push(
          `- **\`${finding.id}\`: ${finding.title}** (${finding.path}:${finding.line}${proposal})\n  Evidence: ${finding.evidence}\n  Failure scenario: ${finding.failureScenario}`,
        )
      }
    }
    if (covered.length > 0) {
      lines.push(
        '',
        `Covered issues: ${covered.map((finding) => `\`${finding.covers}\``).join(', ')}`,
      )
    }
    if (review.unresolved) {
      lines.push(
        '',
        '### ⚠️ Unresolved findings',
        '',
        review.unresolvedIds.length > 0
          ? review.unresolvedIds
              .map((id) => {
                const finding = review.unresolvedFindings.find((entry) => entry.id === id)
                if (finding === undefined) return `- \`${id}\``
                return [
                  `- **\`${finding.id}\` ${finding.severity}: ${finding.title}** (${finding.path}:${finding.line})`,
                  `  ${finding.failureScenario}`,
                  ...(finding.reply === null
                    ? []
                    : [`  Implementer reply (${finding.reply.outcome}): ${finding.reply.reason}`]),
                ].join('\n')
              })
              .join('\n')
          : '- Review ended before all findings could be resolved.',
        '',
        'Verdict: needs-human',
      )
    }
  }
  const footer = meta === undefined ? '' : modelFooter(meta.harness, meta.model, meta.effort)
  return `${lines.join('\n')}${footer}`
}
