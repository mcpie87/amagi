import { ForgeKind, HarnessKind, TaskState, WorkerRole } from '@amagi/core'
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

/** Narrows the diagnostics request snapshot; see `TimingFilter`. */
export const TimingQuery = z.object({
  request: z.string().optional(),
  source: z.string().optional(),
  method: z.string().optional(),
  route: z.string().optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  minMs: z.coerce.number().min(0).optional(),
  maxMs: z.coerce.number().min(0).optional(),
})

/** With a label, the issue list holds only the open issues carrying it. */
export const IssueListQuery = z.object({ label: z.string().min(1).optional() })

/** Every repo-scoped route starts with the workspace key. */
export const RepoParam = z.object({ repo: z.string().min(1) })

/** Combined because hono's zValidator replaces, not merges, a validated target. */
export const RepoTaskIdParam = z.object({ repo: z.string().min(1), id: z.string().min(1) })
export const RepoCommitParam = z.object({
  repo: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{7,40}$/i),
})
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
  compact: z
    .enum(['0', '1'])
    .default('0')
    .transform((value) => value === '1'),
})
export type StreamQuery = z.infer<typeof StreamQuery>

export const AgentLogQuery = z.object({
  attempt: z.coerce.number().int().min(1).default(1),
  untilSeq: z.coerce.number().int().min(0),
  limit: z.coerce.number().int().min(1).max(4000).default(4000),
})
export type AgentLogQuery = z.infer<typeof AgentLogQuery>

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

export const ChecksBody = z.strictObject({
  format: z.string().trim().min(1),
  lint: z.string().trim().min(1),
  test: z.string().trim().min(1),
})

export const SettingsBody = z
  .object({
    autoQueue: z.boolean().optional(),
    autoRebase: z.boolean().optional(),
    ntfyTopic: z.string().trim().optional(),
    ntfyServer: z.string().trim().min(1).optional(),
    desktopFailureAlerts: z.boolean().optional(),
    reviewEnabled: z.boolean().optional(),
    reviewMaxRounds: z.number().int().min(1).optional(),
    forgeKind: ForgeKind.optional(),
    /**
     * Git remote every forge call targets; must name an existing remote of the
     * repo. Null matches it to the forge's host. Changing forgeKind alone also unpins it.
     */
    forgeRemote: z.string().trim().min(1).nullable().optional(),
    /** A credential id picks it for that forge in this repo; null drops the pick. */
    forgeCredentials: z
      .object({
        github: z.string().min(1).nullable().optional(),
        gitlab: z.string().min(1).nullable().optional(),
        forgejo: z.string().min(1).nullable().optional(),
      })
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'provide a setting',
  })
export type SettingsBody = z.infer<typeof SettingsBody>

const nonEmpty = (body: object) => Object.values(body).some((v) => v !== undefined)

export const ForgeCredentialParam = z.object({ id: z.string().min(1) })

/** A forge's web base URL, e.g. https://git.example.com or https://example.com/gitlab. */
const ForgeUrl = z.url({ protocol: /^https?$/ }).trim()

export const ForgeCredentialCreateBody = z.object({
  kind: ForgeKind,
  name: z.string().trim().min(1),
  token: z.string().trim().min(1),
  url: ForgeUrl.nullable().optional(),
})

/** A new token rotates the credential for every repo using it; a null url goes back to origin. */
export const ForgeCredentialUpdateBody = z
  .object({
    name: z.string().trim().min(1).optional(),
    token: z.string().trim().min(1).optional(),
    url: ForgeUrl.nullable().optional(),
  })
  .refine(nonEmpty, { message: 'provide a name, token or url' })

export const WorkerCreateBody = z.object({
  name: z.string().trim().min(1),
  kind: HarnessKind,
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  seat: z.string().trim().min(1).optional(),
  roles: z.array(WorkerRole).default(['implement']),
  count: z.number().int().min(1).max(16).default(1),
  seatCount: z.number().int().min(1).max(16).default(1),
  enabled: z.boolean().default(false),
  difficulties: z.array(z.string().trim().min(1)).optional(),
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
    roles: z.array(WorkerRole).optional(),
    count: z.number().int().min(1).max(16).optional(),
    seatCount: z.number().int().min(1).max(16).optional(),
    enabled: z.boolean().optional(),
    difficulties: z.array(z.string().trim().min(1)).nullable().optional(),
  })
  .refine(nonEmpty, { message: 'provide at least one field' })
export type WorkerUpdateBody = z.infer<typeof WorkerUpdateBody>

export const WatcherParam = z.object({ kind: z.enum(['mention', 'prConflict', 'stall']) })
export const WatcherHistoryParam = z.object({ repo: z.string().min(1), name: z.string().min(1) })
export const WatcherHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeSeq: z.coerce.number().int().min(1).optional(),
})

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

export const SeatNamesUpdateBody = z
  .object({
    seats: z.array(
      z.union([
        z
          .string()
          .trim()
          .min(1)
          .transform((name) => ({ name, count: 1 })),
        z.object({ name: z.string().trim().min(1), count: z.number().int().min(1).max(16) }),
      ]),
    ),
    renames: z
      .array(z.object({ from: z.string().min(1), to: z.string().trim().min(1) }))
      .default([]),
  })
  .refine(({ seats }) => new Set(seats.map(({ name }) => name)).size === seats.length, {
    message: 'seat names must be unique',
  })
export type SeatNamesUpdateBody = z.infer<typeof SeatNamesUpdateBody>

export const ParticipationBody = z
  .object({ workers: z.boolean().optional(), watchers: z.boolean().optional() })
  .refine(nonEmpty, { message: 'provide workers or watchers' })
export type ParticipationBody = z.infer<typeof ParticipationBody>

export const GitIdentityBody = z.union([
  z.null(),
  z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('path'), value: z.string().trim().min(1) }),
    z.object({ mode: z.literal('inline'), value: z.string() }),
  ]),
])
export type GitIdentityBody = z.infer<typeof GitIdentityBody>

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
