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
    '- Never pipe check or lint output through head/tail: it aborts the tool',
    '  (SIGABRT on BrokenPipe) and truncates the report. Redirect to a file instead.',
    '- If your changes add a user-facing feature (new CLI command or flag, new config',
    "  option, new API endpoint), append a short `### How to use` section to the task's",
    '  description in the issue tracker: how to trigger it and what it does. The PR',
    '  description is built from that description.',
    "- Once the work is finished, append a `### Conclusion` section to the task's",
    '  description in the issue tracker, written against the real diff',
    '  (`git diff <base>...HEAD`), not against the task: what the changes do',
    '  file by file and anything the reviewer needs to know (deviations from the',
    '  task, what was left out, why a file that looks unrelated was touched). It',
    '  is mandatory for every PR.',
    '- The task description is rendered verbatim into the PR body as markdown, so',
    '  wrap paths, identifiers and commands in `backticks` where you mean code.',
    '- End your final message with a short summary of what was done; when the task',
    '  has no description it is used as the PR summary, and it is the reason when',
    '  no pull request is opened.',
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

export type MentionPromptContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  worktree: string
  branch: string
  baseBranch: string
  checks: readonly string[]
}

export type TakeDownMentionContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  outPath: string
}

export function respondToMentionSystemPrompt(ctx: MentionPromptContext): string {
  const lines = [
    'You are working inside a dedicated git worktree on a pull request, responding to review feedback from a human.',
    `Worktree: ${ctx.worktree}`,
    `Branch: ${ctx.branch}`,
    `Pull request: #${ctx.pr.number} ${ctx.pr.title} (${ctx.pr.url})`,
    `Base branch: ${ctx.baseBranch}`,
    '',
    'Rules:',
    '- Stay inside this worktree. Do not touch other checkouts of this repository.',
    '- The PR is a completed task; make the smallest change that addresses the feedback, without reworking unrelated code.',
    '- Commit your changes. Do not push; the dispatcher pushes.',
  ]
  return lines.join('\n')
}

export function respondToMentionPrompt(ctx: MentionPromptContext): string {
  const parts = [
    `A human (@${ctx.mention.user}) left feedback on PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
  ]
  if (ctx.checks.length > 0) {
    parts.push(
      '',
      'Run the project checks and make sure they pass before committing:',
      ...ctx.checks.map((c) => `- ${c}`),
    )
  }
  parts.push(
    '',
    'Address the feedback with the smallest change that satisfies it, commit, and stop.',
  )
  return parts.join('\n')
}

export type ExplainMentionContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  diff: string
  outPath: string
}

export function explainMentionSystemPrompt(): string {
  return [
    'You are explaining changes made in a pull request to a human reviewer.',
    'Read the review comment and the diff, then write a clear explanation.',
    'Do not modify any files in the repository.',
  ].join('\n')
}

export type MentionClassifyContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
}

export function classifyMentionSystemPrompt(): string {
  return [
    'You are a classifier for comments on a pull request.',
    'Do not use any tools. Do not modify any files.',
    'Reply with exactly one token, nothing else.',
  ].join('\n')
}

export function classifyMentionPrompt(ctx: MentionClassifyContext): string {
  return [
    `A human (@${ctx.mention.user}) commented on PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
    '',
    'Classify the comment into exactly one of:',
    '- fix-pr: the human wants code in this PR changed',
    '- explain: the human is asking anything about the PR, such as why or how something was done, or whether a change is still relevant, needed, or applies',
    '- add-a-task: the human wants a new task tracked in the issue tracker, not done in this PR',
    '- ambiguous: only when the intent genuinely cannot be determined',
    '',
    'Any question about the PR is explain, never ambiguous. For example, "is this change still relevant?" is explain.',
    '',
    'Reply with exactly one token: fix-pr, explain, add-a-task, or ambiguous.',
  ].join('\n')
}

export function explainMentionPrompt(ctx: ExplainMentionContext): string {
  return [
    `A human (@${ctx.mention.user}) asked about PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
    '',
    `Write your explanation to this file: ${ctx.outPath}`,
    'It will be posted as a comment on the PR. Be concrete: what the changes do, why they were made, and how they fit together.',
    '',
    'Pull request diff:',
    '',
    ctx.diff,
    '',
    'Write the explanation to the file and stop.',
  ].join('\n')
}

export function takeDownSystemPrompt(): string {
  return [
    'You are deciding whether a pull request deserves to be taken down (closed or reverted).',
    'Read the PR and the request, then write a verdict to the file.',
    'Do not modify any files in the repository.',
  ].join('\n')
}

export function takeDownPrompt(ctx: TakeDownMentionContext): string {
  return [
    `A human (@${ctx.mention.user}) asked to take down PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
    '',
    `Write your verdict to this file: ${ctx.outPath}`,
    '',
    'Start the file with one of these verdict lines:',
    '- `TAKE DOWN` when the PR deserves to be taken down, followed by the concise, direct reason on the next line.',
    '- `KEEP` when it does not, followed by a short explanation.',
    '',
    'The reason is posted as a comment on the task issue, so keep it concise and direct.',
  ].join('\n')
}

export type DifficultyClassifyContext = {
  title: string
  description: string
  levels: readonly string[]
}

export function classifyDifficultySystemPrompt(): string {
  return [
    'You are a classifier for issue tracker tasks.',
    'Do not use any tools. Do not modify any files.',
    'Reply with exactly one token, nothing else.',
  ].join('\n')
}

export function classifyDifficultyPrompt(ctx: DifficultyClassifyContext): string {
  const parts = [`Task: ${ctx.title}`]
  if (ctx.description.trim() !== '') parts.push('', ctx.description.trim())
  parts.push(
    '',
    `Classify how difficult this task is for an AI coding agent to implement, into exactly one of: ${ctx.levels.join(', ')}.`,
    'Consider scope, ambiguity, risk, and how many files or systems it likely touches.',
    '',
    `Reply with exactly one token: ${ctx.levels.join(', ')}.`,
  )
  return parts.join('\n')
}

/** The agent changed nothing and left no summary; ask it why for the no_pr reason. */
export function whyNoChangesPrompt(task: TrackerTask): string {
  const parts = [
    `Task ${task.id}: ${task.title}`,
    '',
    'The run ended with no changes in the worktree, so no pull request was opened.',
    'Explain in a few sentences why no changes were made: was the task already done,',
    'unnecessary, or blocked? Your explanation is shown verbatim to the operator as',
    'the reason no PR was opened, so be concrete.',
    '',
    'Do not modify any files; reply with the explanation only.',
  ]
  if (task.description.trim() !== '') parts.push('', task.description.trim())
  return parts.join('\n')
}

/**
 * Pre-implement viability check: a read-only agent pass that catches tasks
 * already satisfied by the current repository before the full implement run
 * starts. The goal is to avoid launching a worker that produces a no-op PR.
 */
export function verifyViabilitySystemPrompt(): string {
  return [
    'You are a viability checker for an autonomous coding agent (amagi).',
    'You decide whether a task still needs work in the current repository, before any',
    'code is written.',
    '',
    'Rules:',
    '- You are read-only: inspect the repository freely, but do not modify, create or',
    '  delete any files, and do not run writing git commands (commit, push, add, checkout).',
    '- Check the code and git history for evidence the task is already done or no longer',
    '  needed: the feature already exists, the fix is already applied, or the work is',
    '  superseded.',
    '- Set viable to false only when the task is clearly already satisfied. When in',
    '  doubt, set viable to true: the check only stops tasks that are obviously done.',
    '',
    'Reply with exactly one JSON object and nothing else:',
    '{',
    '  "viable": true | false,',
    '  "reason": "one short sentence justifying the decision"',
    '}',
  ].join('\n')
}

export function verifyViabilityPrompt(ctx: PromptContext): string {
  const parts = [
    `Decide whether task ${ctx.task.id}: ${ctx.task.title} still needs work in this repository.`,
    '',
    'The current directory is a worktree based on the base branch; the repository state',
    'here is what the task would be implemented against. Inspect it and report whether the',
    'task is still viable.',
  ]
  if (ctx.task.description.trim() !== '') parts.push('', ctx.task.description.trim())
  parts.push('', 'Reply with the JSON object only.')
  return parts.join('\n')
}

/** The slice of an issue the triage decider sees, stripped of tracker plumbing. */
export type TriageTaskView = {
  id: string
  title: string
  description: string
  type: string | null
  status: string
  priority: number | null
  labels: string[]
  parent: string | null
  assignee: string | null
  childCount: number
}

export type TriagePromptContext = {
  task: TriageTaskView
  /** Child issues of a container, with their own statuses, or [] for a leaf. */
  children: TriageTaskView[]
  /** Issues this task is blocked by, when the tracker reports them. */
  dependencies: TrackerTask[]
}

export function triageSystemPrompt(): string {
  return [
    'You are the triage decider for an autonomous coding agent (amagi).',
    'You decide what to do with one unclaimed issue from the project issue tracker.',
    'You never write code or touch the repository; you only decide and report a decision.',
    'Reply with exactly one JSON object and nothing else, matching this schema:',
    '{',
    '  "action": "implement" | "decompose" | "close" | "ask" | "skip",',
    '  "reason": "one short sentence justifying the action",',
    '  "subtasks": [ { "title": "short title", "description": "what to do",',
    '                  "acceptanceCriteria": "how to know it is done" | null,',
    '                  "priority": 2 } ],',
    '  "question": "question for the operator when action is ask",',
    '  "options": ["answer option", "another"]',
    '}',
  ].join('\n')
}

export function triagePrompt(ctx: TriagePromptContext): string {
  const t = ctx.task
  const parts = [
    `Decide what to do with issue ${t.id}: ${t.title}`,
    '',
    `Type: ${t.type ?? 'unknown'}  Status: ${t.status}  Priority: ${t.priority === null ? 'none' : `P${t.priority}`}`,
    ...(t.assignee === null ? [] : [`Assignee: ${t.assignee}`]),
    ...(t.parent === null ? [] : [`Parent: ${t.parent}`]),
  ]
  if (t.description.trim() !== '') parts.push('', t.description.trim())

  if (ctx.children.length > 0) {
    const rows = ctx.children.map(
      (c) => `- ${c.id} [${c.type ?? 'task'}] [${c.status}] P${c.priority ?? '-'} ${c.title}`,
    )
    parts.push('', 'Child issues (do not duplicate work that already has children):', ...rows)
  }

  if (ctx.dependencies.length > 0) {
    const rows = ctx.dependencies.map((d) => `- ${d.id} [${d.status}] ${d.title}`)
    parts.push('', 'Blocked by:', ...rows)
  }

  parts.push(
    '',
    'Choose exactly one action:',
    '- implement: concrete, ready work with no blockers that nothing else already covers.',
    '  Claim it and run the implementation agent.',
    '- decompose: a container (epic/milestone) with no concrete child issues yet; break it',
    '  into concrete, implementable subtasks. Never decompose a container that already has',
    '  open children.',
    '- close: all children are done, or the work is already satisfied (shipped, duplicated,',
    '  superseded).',
    '- ask: genuinely ambiguous, and guessing wrong would waste the task. Give a focused',
    '  question with concrete answer options.',
    '- skip: not for amagi to do (human-only work, infra, out of scope, parked). Record a',
    '  clear reason.',
    '',
    'If the situation changed since a previous decision, prefer the action the current',
    'state calls for; do not repeat an earlier action that no longer applies.',
    '',
    'Do not use any tools. Reply with the JSON object only.',
  )
  return parts.join('\n')
}
