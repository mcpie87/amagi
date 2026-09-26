import type { TrackerTask } from './drivers/types.ts'
import type { CheckResult } from './events.ts'
import { commitFooter } from './footer.ts'
import type { PrBodyMeta } from './pr-body.ts'
import { NOT_VIABLE_VERDICTS, parseVerdict, VERDICTS, verdictPromptLines } from './verdict.ts'

export type PromptContext = {
  task: TrackerTask
  worktree: string
  branch: string
  /** Set once the question channel exists, so the agent is told how to ask. */
  askCommand?: string | null
  /** Set once the server channel exists, so the agent is told how to checkpoint. */
  gitRequestCommand?: string | null
  baseBranch?: string
  /** The gate the orchestrator runs after the agent, in order. */
  checks?: readonly string[]
}

export function implementSystemPrompt(ctx: PromptContext): string {
  const base = ctx.baseBranch ?? '<base>'
  const checks = ctx.checks ?? []
  const lines = [
    'You are working inside a dedicated git worktree on a single tracked task.',
    `Worktree: ${ctx.worktree}`,
    `Branch: ${ctx.branch}`,
    '',
    'Rules:',
    '- Stay inside this worktree. Do not touch other checkouts of this repository.',
    '- Do not commit, push, or otherwise write to git. The orchestrator commits your work.',
    '- Inspect the base with read-only commands such as `git show <base>:<path>` and `git diff <base>`; do not use `git stash`.',
    '- Follow the conventions already present in the code you are changing.',
    ...(checks.length > 0
      ? [
          '- When you finish, the orchestrator runs these checks in order as a mandatory',
          `  gate and sends any failure back to you: ${checks.map((c) => `\`${c}\``).join(', ')}.`,
          '  Run the formatter and lint check yourself before finishing and fix every',
          '  failure; you do not need to run the slow ones to discover them.',
        ]
      : [
          '- Before finishing, run the project formatter then its lint check on your',
          '  changes (e.g. `just fmt` then `just lint`) and fix every failure. The',
          '  orchestrator runs the same commands as a mandatory gate and blocks the',
          '  pull request on them.',
        ]),
    '- While iterating, run the narrowest test that covers your change, not the whole suite.',
    '- Never pipe check or lint output through head/tail: it aborts the tool',
    '  (SIGABRT on BrokenPipe) and truncates the report. Redirect to a file instead.',
    '- Keep your context small: locate code with grep first and read only the line',
    '  ranges you need, do not re-read a file you already have, and check',
    '  `git diff --stat` before reading a full diff, one file at a time.',
    '- Never edit issues with the tracker CLI (bd), and do not re-read this task with',
    '  it: the full issue text (description, notes, comments) is embedded in the',
    '  prompt, and the orchestrator writes the sections of your final message back',
    '  into the issue.',
    '- For investigation-style tasks ("determine whether ... and fix accordingly"), a',
    '  clean working tree is not a valid outcome: even when no code change is needed,',
    '  still write your findings, evidence, and conclusion in your final message.',
    '',
    'Your final message feeds the pull request description. Write it as:',
    '1. A short summary of what was done. It is the body of the commit the orchestrator',
    '   makes, the PR summary when the task has no description, and the reason shown',
    '   when no pull request is opened. Write it against the actual change',
    `   (\`git diff ${base}\`), not against what you intended: open with the problem as a`,
    '   reader who has not seen the code would understand it, then what the change does',
    '   about it and why that matters rather than which mechanism it uses, then how you',
    '   verified it. Do not list the changed files: the diff already shows them.',
    '2. Only if your changes add a user-facing feature (new CLI command or flag, new',
    '   config option, new API endpoint): a `### How to use` section saying how to',
    '   trigger it and what it does.',
    '3. A mandatory `### Conclusion` section written against the real change',
    `   (\`git diff --stat ${base}\` plus \`git status\` for new files), not against the`,
    '   task: what the changes do file by file and anything the reviewer needs to know',
    '   (deviations from the task, what was left out, why a file that looks unrelated',
    '   was touched).',
    'Whenever the summary or Conclusion refers to more than one file, use a markdown',
    'bullet list with one file per line. Put each path in `backticks`; you may add a',
    'short note after it. Never join multiple file paths with commas in a sentence.',
    '4. A mandatory verdict line, also when you changed nothing. A run with no changes',
    '   opens no pull request, so the verdict is what tells the operator what to do next.',
    ...verdictPromptLines().map((l) => `   ${l}`),
    'It is rendered as markdown, so wrap paths, identifiers and commands in `backticks`.',
  ]

  if (ctx.askCommand) {
    lines.push(
      '',
      'If a decision is genuinely ambiguous and picking wrong would waste the task,',
      `ask instead of guessing: ${ctx.askCommand}`,
      'It blocks until a human answers and prints the answer on stdout.',
    )
  }

  if (ctx.gitRequestCommand) {
    lines.push(
      '',
      'To checkpoint mid-run work, you may request a commit:',
      ctx.gitRequestCommand,
      'It blocks until the orchestrator commits the worktree and prints the commit sha',
      'on stdout. It exits non-zero when there is nothing to commit or git fails.',
    )
  }

  return lines.join('\n')
}

/** Notes and comments the tracker carries, so the agent never needs bd to see them. */
function trackerContext(task: TrackerTask): string[] {
  const parts: string[] = []
  const notes = task.notes?.trim()
  if (notes !== undefined && notes !== '') parts.push('', 'Issue notes:', '', notes)
  const comments = (task.comments ?? []).map((c) => c.trim()).filter((c) => c !== '')
  if (comments.length > 0) parts.push('', 'Issue comments:', '', ...comments.map((c) => `- ${c}`))
  return parts
}

export function implementPrompt(ctx: PromptContext): string {
  const parts = [`Task ${ctx.task.id}: ${ctx.task.title}`]
  if (ctx.task.description.trim() !== '') parts.push('', ctx.task.description.trim())
  parts.push(...trackerContext(ctx.task))
  parts.push('', 'Implement this task completely, then stop.')
  return parts.join('\n')
}

/**
 * Sent into the viability check's own session, so the agent keeps what it
 * already read. The task text is repeated because a context restart replays
 * this prompt into a fresh session.
 */
export function implementAfterVerifyPrompt(ctx: PromptContext): string {
  return [
    'The viability check is over and the task is still needed. The read-only rule and',
    'the JSON reply format of the check no longer apply: follow the implementation rules and',
    'implement the task, reusing what you already found instead of re-reading it.',
    '',
    implementPrompt(ctx),
  ].join('\n')
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
  parts.push(...trackerContext(ctx.task))
  parts.push('', 'Continue this task completely, then stop.')
  return parts.join('\n')
}

/**
 * Wraps a phase prompt with a fresh-context restart handoff: the previous
 * session tripped the context guard and was killed, so the new session gets
 * the synthesized handoff of what was done and continues from the worktree
 * state instead of starting over.
 */
export function withRestartHandoff(prompt: string, handoff: string): string {
  return [
    'Your previous session hit the context budget and was stopped. Its work is',
    'still in the worktree. Continue from where it left off instead of starting',
    'over.',
    '',
    'What the previous session did:',
    handoff,
    '',
    'Continue the task below:',
    prompt,
  ].join('\n')
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

/** Body of a commit made before the agent has reported what it did. */
export const CHECKPOINT_COMMIT_SUMMARY =
  'Checkpoint of work in progress, requested by the agent mid-run. The final commit on\n' +
  'this branch summarizes the change.'

/**
 * The commit body out of the implementing run's final message: the summary it
 * opens with, cut before its `### How to use` / `### Conclusion` sections and
 * without the verdict line, which is for the operator.
 */
export function commitSummary(finalMessage: string | null | undefined): string {
  const lines: string[] = []
  for (const line of (finalMessage ?? '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) break
    if (parseVerdict(line) === null) lines.push(line)
  }
  const summary = lines.join('\n').trim()
  return summary === '' ? 'The agent reported no summary of the change.' : summary
}

/**
 * `[task-id] title`, the summary, and the PR body's amagi footer in plain
 * text. commit-lint.ts checks this shape on every amagi commit.
 */
export function commitMessage(
  task: Pick<TrackerTask, 'id' | 'title'>,
  summary: string,
  meta: PrBodyMeta,
): string {
  const footer = commitFooter(meta.harness, meta.model, meta.effort)
  return `[${task.id}] ${task.title}\n\n${summary.trim()}\n\n${footer}\n`
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
  /** Paths still unmerged; the re-dispatch list when an earlier pass left conflicts. */
  conflictFiles?: readonly string[]
  outPath?: string
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
    '- Resolve conflicts by preserving the intent of both branches where possible. Inspect whether base already contains the PR work; do not reinstate a duplicate or fight the base version when it does.',
    "- The PR is another agent's completed task; do not rework its non-conflicting changes.",
    '- Resolve the conflicted files and stop; the runner commits the merge.',
  ]
  if (ctx.outPath !== undefined) {
    lines.splice(
      lines.length - 1,
      0,
      `- Classify the outcome and write a verdict to ${ctx.outPath}.`,
    )
  }
  return lines.join('\n')
}

export function resolveConflictPrompt(ctx: ConflictPromptContext): string {
  const parts = [
    `Resolve the merge conflict in PR #${ctx.pr.number} "${ctx.pr.title}" against ${ctx.baseBranch}.`,
    '',
    'A merge of the base branch is in progress and currently conflicts. Resolve all conflicted files.',
    '',
    'Check whether base already contains the PR work. If it does, preserve base and do not reintroduce a duplicate or fight base’s version just to make the merge look like the PR.',
    ...(ctx.conflictFiles === undefined
      ? []
      : ['', `Currently unresolved: ${ctx.conflictFiles.join(', ')}`]),
  ]
  if (ctx.outPath !== undefined) {
    parts.push(
      '',
      'The dispatcher checks the final diff against base and will never push an empty diff.',
      '',
      'Classify the task using exactly one of these verdicts and write it as the first line to the verdict file:',
      '- `RESOLVED` when the merge has real PR content and nothing is wrong.',
      '- `CLOSE TASK` when base already contains this work.',
      '- `NEW TASK` when base solved it differently and something remains.',
      '- `REPHRASE TASK` when the task as written can no longer be satisfied.',
      `Verdict file: ${ctx.outPath}`,
      'After the verdict line, include `REASONING:` and `PROPOSAL:` sections following the pointless PR verdict format.',
      '',
    )
  }
  if (ctx.checks.length > 0) {
    parts.push(
      '',
      'Run the project checks and make sure they pass before stopping:',
      ...ctx.checks.map((c) => `- ${c}`),
    )
  }
  parts.push(
    '',
    'The runner stages and commits the resolved merge. Stop when the conflicts are resolved.',
  )
  return parts.join('\n')
}

export type MentionPromptContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  worktree: string
  branch: string
  baseBranch: string
  checks: readonly string[]
  outPath: string
  /** True when the base branch does not merge cleanly into the PR head. */
  conflicted: boolean
}

export type TakeDownMentionContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  outPath: string
  /** True when the base branch does not merge cleanly into the PR head. */
  conflicted: boolean
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
    `- Write a short summary of what changed, or why no change was needed, to ${ctx.outPath}.`,
  ]
  if (ctx.conflicted) {
    lines.push(
      '- The base branch does not merge cleanly into this PR. Resolve the conflicts before making your change.',
    )
  }
  return lines.join('\n')
}

export function respondToMentionPrompt(ctx: MentionPromptContext): string {
  const parts = [
    `A human (@${ctx.mention.user}) left feedback on PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
  ]
  if (ctx.conflicted) {
    parts.push(
      '',
      `Note: the base branch ${ctx.baseBranch} does not merge cleanly into this PR.`,
      'Resolve the merge conflicts first, then address the feedback.',
    )
  }
  if (ctx.checks.length > 0) {
    parts.push(
      '',
      'Run the project checks and make sure they pass before stopping:',
      ...ctx.checks.map((c) => `- ${c}`),
    )
  }
  parts.push(
    '',
    'Address the feedback with the smallest change that satisfies it, commit, and stop.',
    `Write a short summary of what changed to file: ${ctx.outPath}. If no change is needed, write why. Keep it concise and suitable for a PR comment.`,
  )
  return parts.join('\n')
}

export type ExplainMentionContext = {
  pr: { number: number; title: string; url: string }
  mention: { user: string; body: string }
  diff: string
  outPath: string
  /** True when the base branch does not merge cleanly into the PR head. */
  conflicted: boolean
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
  const parts = [
    `A human (@${ctx.mention.user}) asked about PR #${ctx.pr.number} "${ctx.pr.title}":`,
    '',
    ctx.mention.body.trim(),
    '',
    `Write your explanation to this file: ${ctx.outPath}`,
    'It will be posted as a comment on the PR. Be concrete: what the changes do, why they were made, and how they fit together.',
  ]
  if (ctx.conflicted) {
    parts.push(
      '',
      'The base branch does not merge cleanly into this PR: the change has drifted from',
      'base. Report this conflict as evidence of that drift in your explanation.',
    )
  }
  parts.push(
    '',
    'Pull request diff:',
    '',
    ctx.diff,
    '',
    'Write the explanation to the file and stop.',
  )
  return parts.join('\n')
}

export function takeDownSystemPrompt(): string {
  return [
    'You are deciding whether a pull request deserves to be taken down (closed or reverted).',
    'Read the PR and the request, then write a verdict to the file.',
    'Do not modify any files in the repository.',
  ].join('\n')
}

export function takeDownPrompt(ctx: TakeDownMentionContext): string {
  const parts = [
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
  ]
  if (ctx.conflicted) {
    parts.push(
      '',
      'The base branch does not merge cleanly into this PR, a sign the change is drifting',
      'from the repository. Weigh this in your verdict.',
    )
  }
  return parts.join('\n')
}

export type PointlessVerdictContext = {
  pr: { number: number; title: string; url: string; body: string }
  /** The task the PR was opened for; null when no task could be resolved. */
  task: { id: string; title: string; description: string } | null
  baseBranch: string
  outPath: string
}

export function pointlessSystemPrompt(): string {
  return [
    'You are deciding what an empty-diff pull request means for the task it was opened for.',
    'Read the repository and the PR, then write a verdict to the file.',
    'Do not modify any files in the repository.',
  ].join('\n')
}

export function pointlessPrompt(ctx: PointlessVerdictContext): string {
  const parts = [
    `PR #${ctx.pr.number} "${ctx.pr.title}" (${ctx.pr.url}) has an empty diff against ${ctx.baseBranch}:`,
    'merging it changes nothing, so a mechanical check labels it as potentially pointless.',
    'The work it was opened for may have already landed on base, been solved differently,',
    'or the task as written may no longer be satisfiable.',
  ]
  if (ctx.task !== null) {
    parts.push('', `Task ${ctx.task.id}: ${ctx.task.title}`)
    if (ctx.task.description.trim() !== '') parts.push('', ctx.task.description.trim())
  } else {
    parts.push('', 'No task could be resolved for this PR.')
  }
  if (ctx.pr.body.trim() !== '') {
    parts.push('', 'Pull request description:', '', ctx.pr.body.trim())
  }
  parts.push(
    '',
    'Inspect the repository to decide which verdict applies. Write your verdict to this',
    `file: ${ctx.outPath}`,
    '',
    'Start the file with exactly one verdict line:',
    '- `RESOLVED` when the merge does have real content and nothing is wrong.',
    '- `CLOSE TASK` when base already contains this work; propose closing the task.',
    '- `NEW TASK` when base solved it differently and something remains; propose a new task for the remainder.',
    '- `REPHRASE TASK` when the task as written can no longer be satisfied; propose new wording.',
    '',
    'Then write two sections, each introduced by its own heading line:',
    '- `REASONING:` followed by why this diff is empty in the context of this task. This is',
    '  posted as the PR comment.',
    '- `PROPOSAL:` followed by the recommendation for the task. This is posted as a comment',
    '  on the task issue, so make it self-contained, naming the task by id.',
    '',
    'The verdict is a recommendation only; nothing is closed, created or edited off the',
    'back of it.',
  )
  return parts.join('\n')
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
    ...verdictPromptLines(),
    '',
    'Do not modify any files; reply with the explanation and the verdict line only.',
  ]
  if (task.description.trim() !== '') parts.push('', task.description.trim())
  parts.push(...trackerContext(task))
  return parts.join('\n')
}

/** Recover from a failed PR creation or explain the manual next step. */
export function prFailurePrompt(task: TrackerTask, branch: string, error: string): string {
  const parts = [
    `Task ${task.id}: ${task.title}`,
    '',
    `The commit is on branch ${branch}, but the forge failed to create its pull request:`,
    error,
    '',
    'Investigate why pull request creation failed. Resolve the problem if you can do',
    'so safely with the available repository state and credentials. The runner will',
    'retry pull request creation once after you finish, so do not open a pull request',
    'yourself. If you cannot resolve it, explain what happened and the exact manual',
    'next step. Be concrete and include relevant commands when useful.',
    '',
    'Do not change project files, git history, branches, or remotes. Do not commit,',
    'push, or retry pull request creation. Reply with a concise summary of what you',
    'investigated, any safe recovery action you took, and the outcome.',
  ]
  if (task.description.trim() !== '') parts.push('', task.description.trim())
  parts.push(...trackerContext(task))
  return parts.join('\n')
}

export function prFailureSystemPrompt(): string {
  return [
    'You are recovering from a failed pull request creation by an autonomous coding agent.',
    'Investigate the failure, make a safe recovery action when possible, and summarize',
    'the result for the operator if recovery does not work.',
    '',
    'Rules:',
    '- Do not change project files, git history, branches, or remotes.',
    '- Do not commit or push, and do not create a pull request yourself; the runner will retry once.',
    '- You may use available tools to inspect the failure and safely correct its cause.',
    '- If you cannot resolve it, report the evidence, what failed, and the exact action',
    '  the operator must take to open the pull request manually.',
    '- Reply with a concise explanation in plain language.',
  ].join('\n')
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
    '  "reason": "one short sentence justifying the decision",',
    `  "verdict": ${NOT_VIABLE_VERDICTS.map((v) => `"${v}"`).join(' | ')}`,
    '}',
    'verdict is required when viable is false and says what should happen to the task:',
    ...VERDICTS.filter((v) => NOT_VIABLE_VERDICTS.includes(v.label)).map(
      (v) => `- ${v.label}: ${v.meaning}`,
    ),
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
