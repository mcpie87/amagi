import type { AgentEvent } from '../events.ts'

export type TrackerStatus = 'open' | 'in_progress' | 'blocked' | 'closed'

export type TrackerTask = {
  id: string
  title: string
  description: string
  status: TrackerStatus
  priority: number | null
  type: string | null
  url: string | null
  /** Difficulty level assigned at creation (e.g. low/medium/high); absent when the tracker did not classify it. */
  difficulty?: string | null
}

/** Opaque handle to whatever the tracker uses to block an issue on a human. */
export type GateRef = {
  id: string
  /** Set when the tracker cannot block, only annotate, so the runner knows to poll elsewhere. */
  advisory: boolean
}

export type Question = {
  id: string
  text: string
  options: readonly string[]
}

/**
 * Which write operations a tracker can perform. The task board hides nothing;
 * an operation a tracker cannot do surfaces as an explicit 501 rather than a
 * silent no-op, so the control room knows exactly what a tracker supports.
 */
export type TrackerCapabilities = {
  /** Creating new issues. */
  create: boolean
  /** Editing issue fields: title, description, acceptance criteria, priority, labels. */
  edit: boolean
  /** Adding and removing dependencies between issues. */
  dependencies: boolean
}

export type CreateTrackerTask = {
  title: string
  description: string
  acceptanceCriteria: string | null
  priority: number | null
  labels: string[]
  /** Issue ids this task depends on (blocked by). */
  dependencies: string[]
  /** Difficulty level stamped at creation; trackers that cannot store it ignore it. */
  difficulty?: string | null
}

export type UpdateTrackerTask = Partial<{
  title: string
  description: string
  acceptanceCriteria: string | null
  priority: number | null
  labels: string[]
  dependencies: { add: string[]; remove: string[] }
}>

export const CAPABILITY_WORDS: Record<keyof TrackerCapabilities, string> = {
  create: 'creating issues',
  edit: 'editing issues',
  dependencies: 'managing dependencies',
}

export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly capability: keyof TrackerCapabilities,
    kind: string,
  ) {
    super(`${kind} tracker does not support ${CAPABILITY_WORDS[capability]}`)
    this.name = 'UnsupportedCapabilityError'
  }
}

export interface Tracker {
  readonly kind: string
  readonly capabilities: TrackerCapabilities

  ready(limit?: number): Promise<TrackerTask[]>
  /** Atomically take the next ready task, or null when the queue is empty. */
  claim(id?: string): Promise<TrackerTask | null>
  get(id: string): Promise<TrackerTask | null>
  /** Create an issue, throwing UnsupportedCapabilityError when the tracker cannot. */
  createTask(input: CreateTrackerTask): Promise<TrackerTask>
  /** Update an issue, throwing UnsupportedCapabilityError when the tracker cannot. */
  updateTask(id: string, input: UpdateTrackerTask): Promise<TrackerTask>
  /** Set or replace metadata keys on an issue; trackers without metadata leave it undefined. */
  setMetadata?(id: string, metadata: Record<string, string>): Promise<void>

  /**
   * Refresh the claim lease. Returns false once the lease is gone, which is
   * the signal to stop working rather than race another worker.
   */
  heartbeat(id: string): Promise<boolean>
  /** Lease TTL the tracker grants, so the runner can pick a heartbeat cadence. */
  readonly leaseTtlMs: number

  comment(id: string, body: string): Promise<void>
  setStatus(id: string, status: TrackerStatus): Promise<void>
  release(id: string): Promise<void>
  close(id: string, reason?: string): Promise<void>

  openGate(taskId: string, question: Question): Promise<GateRef>
  gateResolved(ref: GateRef): Promise<boolean>
  resolveGate(ref: GateRef): Promise<void>
}

export type Permissions = 'workspace-write' | 'bypass'

export type AgentStartOptions = {
  cwd: string
  prompt: string
  systemPrompt?: string
  model?: string
  /** Reasoning effort, passed to the harness when the harness honors it. */
  effort?: string
  permissions?: Permissions
  allowedTools?: readonly string[]
  env?: Record<string, string>
  extraArgs?: readonly string[]
}

export type AgentUsage = {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUsd: number | null
}

export type AgentOutcome = {
  exitCode: number
  ok: boolean
  sessionId: string | null
  summary: string | null
  usage: AgentUsage | null
  stderr: string
}

export interface AgentProcess {
  readonly pid: number
  events(): AsyncIterable<AgentEvent>
  readonly done: Promise<AgentOutcome>
  kill(): Promise<void>
  /** The model the harness reports using, once known (null until then). */
  readonly model: string | null
  /** The reasoning effort in effect, or null when unknown. */
  readonly effort: string | null
}

export interface Harness {
  readonly kind: string
  start(opts: AgentStartOptions): AgentProcess
  /** Continues an existing session so a fix round keeps the original context. */
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess
  /** Models the harness can run, listed the way the harness lists them. */
  listModels(): Promise<string[]>
  /** Reasoning-effort levels the harness can run (for `model`, when the harness scopes them), or [] when it cannot say. */
  listEfforts(model?: string): Promise<string[]>
}
