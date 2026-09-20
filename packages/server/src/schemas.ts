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

export const ApiError = z.object({ error: z.string() })
export type ApiError = z.infer<typeof ApiError>
