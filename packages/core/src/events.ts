import * as z from 'zod'

export const TASK_STATES = [
  'claimed',
  'worktree_ready',
  'implementing',
  'awaiting_answer',
  'checks',
  'committed',
  'pr_open',
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
 * Any state may fall to a terminal state, so those edges are implicit rather
 * than listed here. Only forward progress is enumerated — except the two
 * parked states, which an operator settles as abandoned or, when the work
 * was already satisfied, as done.
 */
const FORWARD: Record<TaskState, readonly TaskState[]> = {
  claimed: ['worktree_ready'],
  worktree_ready: ['implementing'],
  implementing: ['awaiting_answer', 'checks', 'retrying'],
  awaiting_answer: ['implementing'],
  checks: ['implementing', 'committed'],
  retrying: ['implementing'],
  committed: ['pr_open'],
  pr_open: [],
  done: [],
  no_pr: ['abandoned', 'done'],
  needs_human: ['abandoned', 'done'],
  abandoned: [],
  cancelled: [],
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
  return FORWARD[from].includes(to)
}

export const AgentRole = z.enum(['implement', 'chat'])
export type AgentRole = z.infer<typeof AgentRole>

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
  z.object({ kind: z.literal('result'), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
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
  }),
  z.object({
    type: z.literal('task.state'),
    from: TaskState.nullable(),
    to: TaskState,
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal('task.reclaimed'), reason: z.string().optional() }),
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
  z.object({ type: z.literal('checks.finished'), ok: z.boolean(), results: z.array(CheckResult) }),
  z.object({ type: z.literal('commit.created'), sha: z.string(), subject: z.string() }),
  z.object({ type: z.literal('pr.created'), url: z.string(), number: z.number().int() }),
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
  z.object({ type: z.literal('notify.sent'), channel: z.string(), title: z.string() }),
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
