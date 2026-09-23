import type { AgentEvent, AgentRole } from './events.ts'

export type AgentLogLine = {
  id: number
  ts: number
  role: AgentRole
  kind: AgentEvent['kind']
  text: string
}

const CAPACITY = 4000

/**
 * Fixed-size circular buffer of log lines for one task. Never resizes or
 * shifts: writes wrap over the oldest slot once full, so push is O(1)
 * regardless of stream volume.
 */
export class AgentLogBuffer {
  private readonly items: (AgentLogLine | undefined)[] = new Array(CAPACITY)
  private start = 0
  private count = 0
  private nextId = 0
  private readonly listeners = new Set<() => void>()
  version = 0

  get length(): number {
    return this.count
  }

  at(index: number): AgentLogLine | undefined {
    if (index < 0 || index >= this.count) return undefined
    return this.items[(this.start + index) % CAPACITY]
  }

  push(role: AgentRole, ts: number, kind: AgentEvent['kind'], text: string): void {
    const writeIndex = (this.start + this.count) % CAPACITY
    this.items[writeIndex] = { id: this.nextId++, ts, role, kind, text }
    if (this.count < CAPACITY) {
      this.count++
    } else {
      this.start = (this.start + 1) % CAPACITY
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Bumps version and wakes subscribers. Called only from a scheduled flush. */
  notify(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  // a trailing '\n' produces a trailing empty element; drop it, but keep
  // genuine blank lines in the middle of a chunk.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.length === 0 ? [''] : lines
}

function formatUsage(event: Extract<AgentEvent, { kind: 'usage' }>): string {
  const cached = event.cachedTokens !== undefined ? ` cached=${event.cachedTokens}` : ''
  const cost = event.costUsd !== undefined ? ` cost=$${event.costUsd.toFixed(4)}` : ''
  return `tokens in=${event.inputTokens} out=${event.outputTokens}${cached}${cost}`
}

/** Splits one AgentEvent into the individual rows it renders as in the log. */
export function linesForAgentEvent(event: AgentEvent): string[] {
  switch (event.kind) {
    case 'text':
    case 'reasoning':
      return splitLines(event.text)
    case 'tool_use':
      return [`${event.name} ${JSON.stringify(event.input)}`]
    case 'tool_result':
      return splitLines(event.output).map((line) => (event.ok ? line : `! ${line}`))
    case 'usage':
      return [formatUsage(event)]
    case 'context':
      return [`context ${event.tokens} tokens`]
    case 'result':
      return [event.summary ?? (event.ok ? 'done' : 'failed')]
    case 'error':
      return [event.message]
  }
}

export type Scheduler = (flush: () => void) => void

const rafScheduler: Scheduler = (flush) => {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(flush)
  } else {
    setTimeout(flush, 16)
  }
}

/**
 * Owns one AgentLogBuffer per task. Appends mutate the buffer directly and
 * never touch React state; a single flush per animation frame notifies
 * whichever buffers changed, so hundreds of appended lines collapse into at
 * most one re-render per task per frame instead of one setState per line.
 */
export class AgentLogStore {
  private readonly buffers = new Map<string, AgentLogBuffer>()
  private readonly dirty = new Set<string>()
  private flushScheduled = false

  constructor(private readonly schedule: Scheduler = rafScheduler) {}

  get(taskId: string): AgentLogBuffer {
    let buffer = this.buffers.get(taskId)
    if (!buffer) {
      buffer = new AgentLogBuffer()
      this.buffers.set(taskId, buffer)
    }
    return buffer
  }

  append(taskId: string, role: AgentRole, ts: number, event: AgentEvent): void {
    const buffer = this.get(taskId)
    for (const line of linesForAgentEvent(event)) {
      buffer.push(role, ts, event.kind, line)
    }
    this.dirty.add(taskId)
    this.scheduleFlush()
  }

  subscribe(taskId: string, listener: () => void): () => void {
    return this.get(taskId).subscribe(listener)
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    this.schedule(() => {
      this.flushScheduled = false
      const taskIds = [...this.dirty]
      this.dirty.clear()
      for (const taskId of taskIds) {
        this.buffers.get(taskId)?.notify()
      }
    })
  }
}

/** Shared store for the running app; tests construct their own with a synchronous scheduler. */
export const agentLogStore = new AgentLogStore()
