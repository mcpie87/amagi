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
