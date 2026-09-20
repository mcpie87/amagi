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

export interface Tracker {
  readonly kind: string

  ready(limit?: number): Promise<TrackerTask[]>
  /** Atomically take the next ready task, or null when the queue is empty. */
  claim(id?: string): Promise<TrackerTask | null>
  get(id: string): Promise<TrackerTask | null>

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
}
