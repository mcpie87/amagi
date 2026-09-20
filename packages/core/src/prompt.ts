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
