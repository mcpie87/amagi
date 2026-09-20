import type { TrackerTask } from './drivers/types.ts'
import type { CheckResult } from './events.ts'

export type PromptContext = {
  task: TrackerTask
  worktree: string
  branch: string
  /** Set once the question channel exists, so the agent is told how to ask. */
  askCommand?: string | null
}

export function implementSystemPrompt(ctx: PromptContext): string {
  const lines = [
    'You are working inside a dedicated git worktree on a single tracked task.',
    `Worktree: ${ctx.worktree}`,
    `Branch: ${ctx.branch}`,
    '',
    'Rules:',
    '- Stay inside this worktree. Do not touch other checkouts of this repository.',
    '- Do not commit, push, or otherwise write to git. The orchestrator commits your work.',
    '- Follow the conventions already present in the code you are changing.',
    "- Run the project's own checks if you are unsure a change is correct.",
  ]

  if (ctx.askCommand) {
    lines.push(
      '',
      'If a decision is genuinely ambiguous and picking wrong would waste the task,',
      `ask instead of guessing: ${ctx.askCommand}`,
      'It blocks until a human answers and prints the answer on stdout.',
    )
  }

  return lines.join('\n')
}

export function implementPrompt(ctx: PromptContext): string {
  const parts = [`Task ${ctx.task.id}: ${ctx.task.title}`]
  if (ctx.task.description.trim() !== '') parts.push('', ctx.task.description.trim())
  parts.push('', 'Implement this task completely, then stop.')
  return parts.join('\n')
}

/** A previously interrupted run was reclaimed and its worktree resumed. */
export function reclaimPrompt(ctx: PromptContext): string {
  const parts = [
    `Task ${ctx.task.id}: ${ctx.task.title}`,
    '',
    'This task was interrupted mid-run and is being resumed. Existing work is',
    'already in the worktree and branch; inspect the current state, continue',
    'where it left off, and finish what is missing.',
  ]
  if (ctx.task.description.trim() !== '') parts.push('', ctx.task.description.trim())
  parts.push('', 'Continue this task completely, then stop.')
  return parts.join('\n')
}

export function answerPrompt(question: string, answer: string): string {
  return [
    'A human answered the question you were waiting on. Continue the task.',
    '',
    `Question: ${question}`,
    `Answer: ${answer}`,
    '',
    'Apply the answer and finish the task, then stop.',
  ].join('\n')
}

export function fixChecksPrompt(results: readonly CheckResult[]): string {
  const failed = results.filter((r) => r.exitCode !== 0)
  const blocks = failed.map((r) => `$ ${r.command}\nexit ${r.exitCode}\n${r.output.trim()}`)
  return ['The project checks failed on your changes. Fix them, then stop.', '', ...blocks].join(
    '\n',
  )
}

export function commitMessage(task: TrackerTask): string {
  return `${task.title}\n\nTask: ${task.id}\n`
}

/**
 * PR title in `code: short name` form, not the full issue sentence. The short
 * name drops a milestone-style `M5: ` prefix and any trailing clauses, so
 * "PR titles should use task code, not full sentences" becomes
 * "am-544: PR titles should use task code".
 */
export function prTitle(task: TrackerTask): string {
  const withoutMilestone = task.title.replace(/^M\d+(?:\.\d+)*\s*:\s*/, '')
  const shortName = withoutMilestone.split(/[.,;]/)[0]?.trim() ?? withoutMilestone.trim()
  return `${task.id}: ${shortName}`
}

export type ConflictPromptContext = {
  pr: { number: number; title: string; url: string }
  worktree: string
  branch: string
  baseBranch: string
  checks: readonly string[]
}

export function resolveConflictSystemPrompt(ctx: ConflictPromptContext): string {
  const lines = [
    'You are working inside a dedicated git worktree, resolving a merge conflict in a pull request.',
    `Worktree: ${ctx.worktree}`,
    `Branch: ${ctx.branch}`,
    `Pull request: #${ctx.pr.number} ${ctx.pr.title} (${ctx.pr.url})`,
    `Base branch: ${ctx.baseBranch}`,
    '',
    'Rules:',
    '- Stay inside this worktree. Do not touch other checkouts of this repository.',
    '- Resolve every conflict in favor of the pull request intent, keeping base branch changes where both are wanted.',
    "- The PR is another agent's completed task; do not rework its non-conflicting changes.",
    '- Commit the resolved merge to finish the in-progress merge. Do not push; the dispatcher pushes.',
  ]
  return lines.join('\n')
}

export function resolveConflictPrompt(ctx: ConflictPromptContext): string {
  const parts = [
    `Resolve the merge conflict in PR #${ctx.pr.number} "${ctx.pr.title}" against ${ctx.baseBranch}.`,
    '',
    'A merge of the base branch is in progress and currently conflicts. Resolve all conflicted files.',
  ]
  if (ctx.checks.length > 0) {
    parts.push(
      '',
      'Run the project checks and make sure they pass before committing:',
      ...ctx.checks.map((c) => `- ${c}`),
    )
  }
  parts.push('', 'Then finish the merge with `git add -A` and `git commit`, and stop.')
  return parts.join('\n')
}
