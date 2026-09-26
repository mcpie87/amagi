import { randomUUID } from 'node:crypto'
import type { AgentOutcome, AgentProcess } from './drivers/types.ts'
import type { AgentEvent, AgentRole } from './events.ts'
import type { Store } from './store/store.ts'

export type WatcherAgentSession = {
  store: Store
  role: AgentRole
  harness: string
  source: string
  cwd: string
}

/** Records one null-task watcher harness run without retaining its text stream. */
export async function recordWatcherAgentRun(
  proc: AgentProcess,
  session: WatcherAgentSession,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentOutcome> {
  const watcherRunId = randomUUID()
  const { store, role, harness, source, cwd } = session
  store.append(null, {
    type: 'agent.started',
    role,
    harness,
    model: proc.model,
    effort: proc.effort,
    cwd,
    resumed: false,
    watcherRunId,
    watcherSource: source,
  })

  let outcome: AgentOutcome | null = null
  try {
    for await (const event of proc.events()) {
      if (event.kind === 'usage') {
        store.append(null, {
          type: 'agent.stream',
          role,
          event,
          watcherRunId,
          watcherSource: source,
        })
      }
      onEvent?.(event)
    }
    outcome = await proc.done
    return outcome
  } finally {
    if (outcome === null) {
      try {
        outcome = await proc.done
      } catch {
        outcome = null
      }
    }
    store.append(null, {
      type: 'agent.exited',
      role,
      exitCode: outcome?.exitCode ?? 1,
      sessionId: outcome?.sessionId ?? null,
      watcherRunId,
      watcherSource: source,
    })
  }
}
