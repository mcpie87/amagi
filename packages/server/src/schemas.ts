import { HarnessKind, TaskState } from '@amagi/core'
import * as z from 'zod'

/**
 * Hono flattens a repeated query parameter to an array but a single one to a
 * bare string, so every list filter has to accept both shapes.
 */
const list = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',') : v), z.array(item).min(1))

export const TaskListQuery = z.object({
  state: list(TaskState).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})
export type TaskListQuery = z.infer<typeof TaskListQuery>

/** Every repo-scoped route starts with the workspace key. */
export const RepoParam = z.object({ repo: z.string().min(1) })

/** Combined because hono's zValidator replaces, not merges, a validated target. */
export const RepoTaskIdParam = z.object({ repo: z.string().min(1), id: z.string().min(1) })
export const RepoQuestionParam = z.object({
  repo: z.string().min(1),
  id: z.string().min(1),
  questionId: z.string().min(1),
})

export const RepoRegisterBody = z.object({
  path: z.string().min(1),
  key: z.string().min(1).optional(),
})
export type RepoRegisterBody = z.infer<typeof RepoRegisterBody>

export const EventQuery = z.object({
  taskId: z.string().min(1).optional(),
  sinceSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
})
export type EventQuery = z.infer<typeof EventQuery>

export const StreamQuery = z.object({
  taskId: z.string().min(1).optional(),
  sinceSeq: z.coerce.number().int().min(0).default(0),
})
export type StreamQuery = z.infer<typeof StreamQuery>

export const QuestionQuery = z.object({
  taskId: z.string().min(1).optional(),
})

export const AskBody = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
})
export type AskBody = z.infer<typeof AskBody>

/**
 * Empty body launches the next ready task; an optional workerId selects its worker.
 */
export const RunBody = z.object({
  taskId: z.string().min(1).optional(),
  workerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
})
export type RunBody = z.infer<typeof RunBody>

export const TaskIdParam = z.object({ id: z.string().min(1) })

/** Operator-supplied reason for closing a needs_human/no_pr task. */
export const CloseTaskBody = z.object({
  reason: z.string().trim().min(1).max(1000),
  /** Retire a parked no_pr/needs_human task as done instead of abandoned. */
  to: z.enum(['done', 'abandoned']).default('abandoned'),
})
export type CloseTaskBody = z.infer<typeof CloseTaskBody>

/** Operator-supplied reason for closing eligible epics. */
export const EpicCloseBody = z.object({
  reason: z.string().trim().min(1).max(1000),
})
export type EpicCloseBody = z.infer<typeof EpicCloseBody>

export const AnswerBody = z.object({
  answer: z.string().min(1),
  via: z.enum(['web', 'cli', 'gate']).default('web'),
})
export type AnswerBody = z.infer<typeof AnswerBody>

/**
 * The closed set of git writes an agent can request. The runner never parses
 * prose and never interprets anything outside this set; an unknown verb is
 * rejected as a 400 before any work happens.
 */
export const GitRequestVerb = z.enum(['commit'])
export type GitRequestVerb = z.infer<typeof GitRequestVerb>

export const GitRequestBody = z.object({
  verb: GitRequestVerb,
})
export type GitRequestBody = z.infer<typeof GitRequestBody>

/** A message from the operator to the worker behind a parked task. */
export const ChatBody = z.object({
  message: z.string().trim().min(1).max(4000),
})
export type ChatBody = z.infer<typeof ChatBody>

export const SettingsBody = z
  .object({
    autoQueue: z.boolean().optional(),
  })
  .refine((body) => body.autoQueue !== undefined, {
    message: 'provide autoQueue',
  })
export type SettingsBody = z.infer<typeof SettingsBody>

const nonEmpty = (body: object) => Object.values(body).some((v) => v !== undefined)

export const WorkerCreateBody = z.object({
  name: z.string().trim().min(1),
  kind: HarnessKind,
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  seat: z.string().trim().min(1).optional(),
  enabled: z.boolean().default(true),
})
export type WorkerCreateBody = z.infer<typeof WorkerCreateBody>

/** A null clears an optional field back to the harness default. */
export const WorkerUpdateBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    kind: HarnessKind.optional(),
    model: z.string().trim().min(1).nullable().optional(),
    effort: z.string().trim().min(1).nullable().optional(),
    seat: z.string().trim().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
    /** Runtime only: whether the auto-queue may dispatch to this worker. Never persisted. */
    on: z.boolean().optional(),
  })
  .refine(nonEmpty, { message: 'provide at least one field' })
export type WorkerUpdateBody = z.infer<typeof WorkerUpdateBody>

export const WatcherParam = z.object({ kind: z.enum(['mention', 'prConflict', 'stall']) })

export const WatcherUpdateBody = z
  .object({
    enabled: z.boolean().optional(),
    kind: HarnessKind.nullable().optional(),
    model: z.string().trim().min(1).nullable().optional(),
    effort: z.string().trim().min(1).nullable().optional(),
    seat: z.string().trim().min(1).nullable().optional(),
  })
  .refine(nonEmpty, { message: 'provide at least one field' })
export type WatcherUpdateBody = z.infer<typeof WatcherUpdateBody>

export const ParticipationBody = z
  .object({ workers: z.boolean().optional(), watchers: z.boolean().optional() })
  .refine(nonEmpty, { message: 'provide workers or watchers' })
export type ParticipationBody = z.infer<typeof ParticipationBody>

/** Defaults to the loop.questionTimeoutSec the runner hands the agent. */
export const AwaitQuery = z.object({
  deadlineMs: z.coerce.number().int().min(1).default(540_000),
})
export type AwaitQuery = z.infer<typeof AwaitQuery>

export const IssueCreateBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().default(''),
  acceptanceCriteria: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(4).nullable().default(null),
  labels: z.array(z.string()).default([]),
  /** Issue ids the new task is blocked by. */
  dependencies: z.array(z.string()).default([]),
  /** Parent issue id when the task is a child of a container (epic/milestone). */
  parent: z.string().nullable().default(null),
})
export type IssueCreateBody = z.infer<typeof IssueCreateBody>

export const IssueUpdateBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(4).nullable().optional(),
  labels: z.array(z.string()).optional(),
  /** Full desired set of blocker ids; the server diffs against the current set. */
  dependencies: z.array(z.string()).optional(),
})
export type IssueUpdateBody = z.infer<typeof IssueUpdateBody>
