import type { AgentRole, StoredEvent } from './events.ts'

/**
 * One agent run, folded from the event log. A run that never produced an
 * agent.exited (the log ends, or the process was killed) is still listed, with
 * endedAt/durationMs null so the UI can mark it in-flight.
 */
export type SessionView = {
  taskId: string | null
  watcherRunId: string | null
  watcherSource: string | null
  sessionId: string | null
  role: AgentRole
  harness: string
  model: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  exitCode: number | null
  usedTokens: number
  cachedTokens: number
  costUsd: number
}

/**
 * Folds the event log into one session per agent run: agent.started opens a
 * session, usage streams accumulate into it, and agent.exited closes it with a
 * duration. Task runs are keyed by taskId; watcher runs use their unique run id
 * because they intentionally have no task projection.
 */
export function sessionsFromEvents(events: StoredEvent[]): SessionView[] {
  const sessions: SessionView[] = []
  const open = new Map<string, SessionView>()

  for (const event of events) {
    switch (event.type) {
      case 'agent.started': {
        const key = event.taskId ?? (event.watcherRunId ? `watcher:${event.watcherRunId}` : null)
        if (key === null) break
        const session: SessionView = {
          taskId: event.taskId,
          watcherRunId: event.watcherRunId ?? null,
          watcherSource: event.watcherSource ?? null,
          sessionId: null,
          role: event.role,
          harness: event.harness,
          model: event.model,
          startedAt: event.ts,
          endedAt: null,
          durationMs: null,
          exitCode: null,
          usedTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
        }
        open.set(key, session)
        sessions.push(session)
        break
      }
      case 'agent.stream': {
        if (event.event.kind !== 'usage') break
        const key = event.taskId ?? (event.watcherRunId ? `watcher:${event.watcherRunId}` : null)
        if (key === null) break
        const session = open.get(key)
        if (session === undefined) break
        session.usedTokens += event.event.inputTokens + event.event.outputTokens
        session.cachedTokens += event.event.cachedTokens ?? 0
        session.costUsd += event.event.costUsd ?? 0
        break
      }
      case 'agent.exited': {
        const key = event.taskId ?? (event.watcherRunId ? `watcher:${event.watcherRunId}` : null)
        if (key === null) break
        const session = open.get(key)
        if (session === undefined) break
        session.endedAt = event.ts
        session.durationMs = event.ts - session.startedAt
        session.exitCode = event.exitCode
        if (event.sessionId !== null) session.sessionId = event.sessionId
        open.delete(key)
        break
      }
      default:
        break
    }
  }
  return sessions
}
