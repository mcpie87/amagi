import { TaskState } from '@amagi/core'
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

export const TaskIdParam = z.object({ id: z.string().min(1) })

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

export const TaskQuestionParam = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
})

export const AskBody = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).default([]),
})
export type AskBody = z.infer<typeof AskBody>

/** Empty body (or `{}`) launches the next ready task. */
export const RunBody = z.object({
  taskId: z.string().min(1).optional(),
})
export type RunBody = z.infer<typeof RunBody>

export const AnswerBody = z.object({
  answer: z.string().min(1),
  via: z.enum(['web', 'cli', 'gate']).default('web'),
})
export type AnswerBody = z.infer<typeof AnswerBody>

/** Defaults to the loop.questionTimeoutSec the runner hands the agent. */
export const AwaitQuery = z.object({
  deadlineMs: z.coerce.number().int().min(1).default(540_000),
})
export type AwaitQuery = z.infer<typeof AwaitQuery>

export const ApiError = z.object({ error: z.string() })
export type ApiError = z.infer<typeof ApiError>

export const IssueIdParam = z.object({ id: z.string().min(1) })

export const IssueCreateBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().default(''),
  acceptanceCriteria: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(4).nullable().default(null),
  labels: z.array(z.string()).default([]),
  /** Issue ids the new task is blocked by. */
  dependencies: z.array(z.string()).default([]),
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
