import * as z from 'zod'

/** Whether an open PR can merge, normalized across forges (GitHub and Forgejo report different vocabularies). */
export const MERGE_STATUSES = ['mergeable', 'conflicted', 'unknown'] as const
export const MergeStatus = z.enum(MERGE_STATUSES)
export type MergeStatus = z.infer<typeof MergeStatus>

export const TASK_STATES = [
  'claimed',
  'worktree_ready',
  'implementing',
  'awaiting_answer',
  'checks',
  'committed',
  'pr_open',
  'pr_flagged',
  'retrying',
  'done',
  'no_pr',
  'needs_human',
  'abandoned',
  'cancelled',
] as const

export const TaskState = z.enum(TASK_STATES)
export type TaskState = z.infer<typeof TaskState>

export const TERMINAL_STATES = [
  'done',
  'no_pr',
  'needs_human',
  'abandoned',
  'cancelled',
] as const satisfies readonly TaskState[]

export function isTerminal(state: TaskState): boolean {
  return (TERMINAL_STATES as readonly TaskState[]).includes(state)
}

/**
 * Whether the operator may start a task over from scratch: any parked task,
 * or an in-flight one stuck before it got a worktree. Never done/abandoned
 * (the tracker issue is closed) nor a task with a PR, which would dangle.
 */
export function canReset(state: TaskState, hasWorktree: boolean): boolean {
  if (state === 'cancelled' || state === 'needs_human' || state === 'no_pr') return true
  if (isTerminal(state) || state === 'pr_open' || state === 'pr_flagged') return false
  return !hasWorktree
}

/**
 * Any state may fall to a terminal state, so those edges are implicit rather
 * than listed here. Only forward progress is enumerated; the operator-settled
 * exits of the parked/stopped states are special-cased in canTransition, not
 * listed here.
 */
const FORWARD: Partial<Record<TaskState, readonly TaskState[]>> = {
  claimed: ['worktree_ready'],
  worktree_ready: ['implementing'],
  implementing: ['awaiting_answer', 'checks', 'retrying'],
  awaiting_answer: ['implementing'],
  checks: ['implementing', 'committed'],
  retrying: ['implementing'],
  committed: ['pr_open'],
  pr_open: ['pr_flagged'],
  // A flagged PR is parked for the operator, not terminal: the watcher owns
  // the label and clears it back to pr_open when the PR stops being pointless.
  pr_flagged: ['pr_open'],
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  if (from === to) return false
  // A parked or stopped task is retired by the operator's close action: a
  // stopped run parks as cancelled (worktree preserved), and instant close
  // then abandons it and deletes the worktree. A no_pr/needs_human task whose
  // agent left no changes because the work was already done may instead be
  // marked done.
  if (to === 'abandoned' && (from === 'needs_human' || from === 'no_pr' || from === 'cancelled')) {
    return true
  }
  if (to === 'done' && (from === 'needs_human' || from === 'no_pr')) {
    return true
  }
  if (isTerminal(from)) return false
  if (isTerminal(to)) return true
  return FORWARD[from]?.includes(to) ?? false
}

export const AgentRole = z.enum(['implement', 'review', 'triage', 'chat', 'verify'])
export type AgentRole = z.infer<typeof AgentRole>

/** What the triage worker decides to do with an unclaimed task. */
export const TriageAction = z.enum(['implement', 'decompose', 'close', 'ask', 'skip'])
export type TriageAction = z.infer<typeof TriageAction>

/** One harness dialect normalized into a single shape. */
export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  z.object({ kind: z.literal('tool_use'), name: z.string(), input: z.unknown() }),
  z.object({
    kind: z.literal('tool_result'),
    name: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal('usage'),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    /** Input tokens served from the provider's prompt cache, when reported. */
    cachedTokens: z.number().int().optional(),
    costUsd: z.number().optional(),
  }),
  /**
   * Input context of the latest single model request, which is what the
   * context guard measures. Never derive it from `usage`: harnesses report
   * that as a running total across every request of a session.
   */
  z.object({ kind: z.literal('context'), tokens: z.number().int() }),
  z.object({ kind: z.literal('result'), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
  z.object({ kind: z.literal('status'), message: z.string() }),
])
export type AgentEvent = z.infer<typeof AgentEvent>

export const CheckResult = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  output: z.string(),
})
export type CheckResult = z.infer<typeof CheckResult>

export const EventBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.claimed'),
    title: z.string(),
    tracker: z.string(),
    description: z.string().optional(),
    priority: z.number().nullable().optional(),
    taskType: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    difficulty: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('claim.rejected'),
    title: z.string(),
    difficulty: z.string().nullable().optional(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal('task.state'),
    from: TaskState.nullable(),
    to: TaskState,
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('task.reclaimed'), reason: z.string().optional() }),
  /** Operator reset: the task starts a fresh attempt; earlier events stay as history. */
  z.object({ type: z.literal('task.reset'), reason: z.string().optional() }),
  z.object({
    type: z.literal('doom.detected'),
    /** Which heuristic tripped: repeated tool calls, identical check failures, static diff. */
    kind: z.enum(['tool_repeat', 'check_repeat', 'diff_static']),
    detail: z.string(),
  }),
  z.object({ type: z.literal('worktree.created'), path: z.string(), branch: z.string() }),
  z.object({ type: z.literal('worktree.removed'), path: z.string() }),
  z.object({
    type: z.literal('chat.message'),
    /** The operator's message to the worker; a chat run's answer streams as agent.stream. */
    text: z.string(),
  }),
  z.object({
    type: z.literal('agent.started'),
    role: AgentRole,
    harness: z.string(),
    /** The model the harness resolved at spawn, if it reports one. */
    model: z.string().nullable(),
    /** The reasoning effort the harness resolved at spawn, if known. */
    effort: z.string().nullable(),
    cwd: z.string(),
    resumed: z.boolean(),
  }),
  z.object({ type: z.literal('agent.stream'), role: AgentRole, event: AgentEvent }),
  z.object({
    type: z.literal('agent.exited'),
    role: AgentRole,
    exitCode: z.number().int(),
    sessionId: z.string().nullable(),
  }),
  /**
   * The run's running peak input context as context events stream in. Appended each time the peak grows; the last one of a run
   * is its peak context.
   */
  z.object({ type: z.literal('run.context'), contextTokens: z.number().int() }),
  /**
   * The effective run-health ceilings for the active harness, appended once per
   * claim so clients can render context/cost/elapsed against them before any
   * guard trips. A maxRunMs or maxCostUsd of 0 means that budget is unbounded.
   */
  z.object({
    type: z.literal('run.limits'),
    contextWarnTokens: z.number().int(),
    contextMaxTokens: z.number().int(),
    maxRunMs: z.number().int(),
    maxCostUsd: z.number(),
  }),
  /** Logged once when the run's peak context crosses the soft limit. */
  z.object({
    type: z.literal('context.warn'),
    contextTokens: z.number().int(),
    limit: z.number().int(),
  }),
  /** Logged once when the run's peak context crosses the hard limit, right before the agent is killed. */
  z.object({
    type: z.literal('context.exceeded'),
    contextTokens: z.number().int(),
    limit: z.number().int(),
  }),
  /**
   * A run that crossed the hard context limit was restarted with a fresh
   * session in the same worktree; `summary` is the handoff of what the killed
   * session did, handed to the new one as context. `restart` is 1-based.
   */
  z.object({
    type: z.literal('run.restarted'),
    phase: z.string(),
    restart: z.number().int().positive(),
    contextTokens: z.number().int(),
    summary: z.string(),
  }),
  z.object({ type: z.literal('checks.finished'), ok: z.boolean(), results: z.array(CheckResult) }),
  z.object({ type: z.literal('commit.created'), sha: z.string(), subject: z.string() }),
  z.object({ type: z.literal('pr.created'), url: z.string(), number: z.number().int() }),
  z.object({ type: z.literal('pr.status'), mergeStatus: MergeStatus }),
  /**
   * The git shim rejected an agent's write attempt inside the protected repo.
   * `argv` is the rejected call without the leading `git` (e.g. `["commit",
   * "-m", "x"]`).
   */
  z.object({ type: z.literal('git.blocked'), argv: z.array(z.string()) }),
  /**
   * The worktree's HEAD moved during an agent run without the runner doing it:
   * the agent reached the real git past the shim (an absolute path, a
   * rewritten PATH). `entries` are the new HEAD reflog lines, newest first, as
   * `<sha> <reflog subject>` (e.g. `"abc123 reset: moving to HEAD"` for a stash).
   */
  z.object({ type: z.literal('git.bypassed'), entries: z.array(z.string()) }),
  z.object({
    type: z.literal('question.asked'),
    questionId: z.string(),
    question: z.string(),
    options: z.array(z.string()),
    gateRef: z.string().nullable(),
  }),
  z.object({
    type: z.literal('question.answered'),
    questionId: z.string(),
    answer: z.string(),
    via: z.enum(['web', 'cli', 'gate']),
  }),
  z.object({ type: z.literal('question.timedout'), questionId: z.string() }),
  z.object({ type: z.literal('question.parked'), questionId: z.string() }),
  z.object({
    type: z.literal('retry.scheduled'),
    /** 1-based retry attempt about to run. */
    attempt: z.number().int().positive(),
    delayMs: z.number().int().nonnegative(),
    reason: z.string(),
    detail: z.string(),
  }),
  z.object({
    type: z.literal('retry.filed_as_error'),
    /** The tracker task created to carry the error message. */
    errorTaskId: z.string(),
    /** The recorded error the error task carries. */
    reason: z.string(),
  }),
  z.object({ type: z.literal('notify.sent'), channel: z.string(), title: z.string() }),
  z.object({
    type: z.literal('mention.classified'),
    /** Which response path the classifier chose for the mention. */
    kind: z.enum(['fix-pr', 'explain', 'add-a-task', 'take-down', 'ambiguous']),
    /** The raw classifier reply; when the parse is wrong this is all that explains why. */
    reply: z.string(),
    /** The PR the mention was on. */
    prNumber: z.number().int(),
    /** The comment id of the mention. */
    mentionId: z.string(),
  }),
  z.object({
    type: z.literal('triage.decision'),
    action: TriageAction,
    reason: z.string(),
    /** Titles of the subtasks a decompose decision created. */
    subtasks: z.array(z.string()).optional(),
    /** The question text when the action was ask. */
    question: z.string().optional(),
    /** The question id when the action was ask, so an answer can be matched back. */
    questionId: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), fatal: z.boolean() }),
])
export type EventBody = z.infer<typeof EventBody>
export type EventType = EventBody['type']

export const StoredEvent = z.intersection(
  z.object({
    seq: z.number().int(),
    ts: z.number().int(),
    taskId: z.string().nullable(),
  }),
  EventBody,
)
export type StoredEvent = z.infer<typeof StoredEvent>

/**
 * The task's events since its last operator reset: budgets, usage and health
 * belong to the current attempt only. Events of other tasks are dropped.
 */
export function currentAttemptEvents(events: StoredEvent[], taskId: string): StoredEvent[] {
  let start = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e?.taskId === taskId && e.type === 'task.reset') {
      start = i
      break
    }
  }
  return events.slice(start).filter((e) => e.taskId === taskId)
}
