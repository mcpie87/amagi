import { agentLogStore } from '@amagi/core/agent-log'
import type { StoredEvent } from '@amagi/core/events'
import type { RunnerStatus } from '@amagi/core/run-service'
import { type DashboardState, initialDashboardState, reduceState } from '@amagi/core/view'
import { createContext, type ReactNode, useContext, useEffect, useReducer, useState } from 'react'

const DashboardContext = createContext<DashboardState>(initialDashboardState())
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting'
const ConnectionContext = createContext<ConnectionStatus>('connecting')

/**
 * One EventSource carries the whole store. The server replays from
 * `sinceSeq` and honours the browser's Last-Event-ID on reconnect, so a page
 * reload reconstructs identical state by folding the replay back over the
 * reducer. No query cache: the API list endpoints are not consulted.
 */
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceState, undefined, initialDashboardState)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    const base = (import.meta.env.VITE_API_BASE ?? '') as string
    const source = new EventSource(`${base}/api/stream?sinceSeq=0`)
    source.addEventListener('open', () => setConnection('connected'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('message', (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as StoredEvent
        // agent.stream is the hot path: hundreds of lines/sec of assistant
        // text and tool output. It bypasses the reducer entirely so it never
        // costs a setState per line; the ring buffer in agentLog.ts owns it
        // and batches renders on requestAnimationFrame instead.
        if (parsed.type === 'agent.stream' && parsed.taskId !== null) {
          agentLogStore.append(parsed.taskId, parsed.role, parsed.ts, parsed.event)
          // usage is sparse (one per step/turn, not per line): the only
          // agent.stream event the reducer needs, for the sessions view.
          // Chat runs are also routed to the reducer so the chat panel can
          // fold their text into a conversation; the reducer itself ignores
          // agent.stream, only the event log accumulates it.
          if (parsed.event.kind === 'usage' || parsed.role === 'chat') dispatch(parsed)
        } else {
          dispatch(parsed)
        }
      } catch {
        // a malformed event must not drop the stream
      }
    })
    return () => source.close()
  }, [])

  return (
    <ConnectionContext.Provider value={connection}>
      <DashboardContext.Provider value={state}>{children}</DashboardContext.Provider>
    </ConnectionContext.Provider>
  )
}

export function useDashboard(): DashboardState {
  return useContext(DashboardContext)
}

export type RunnerApi = {
  status: RunnerStatus | null
  start: (taskId?: string) => Promise<{ ok: true; taskId: string } | { ok: false; error?: string }>
  stop: (taskId: string) => Promise<{ ok: boolean; error?: string }>
}

const RunnerContext = createContext<RunnerApi>({
  status: null,
  start: async () => ({ ok: false }),
  stop: async () => ({ ok: false }),
})

/** Runner availability plus launch/stop, polled so the header stays honest. */
export function RunnerProvider({ children }: { children: ReactNode }) {
  const base = (import.meta.env.VITE_API_BASE ?? '') as string
  const [status, setStatus] = useState<RunnerStatus | null>(null)

  const refresh = () => {
    fetch(`${base}/api/runner`)
      .then((r) => (r.ok ? (r.json() as Promise<RunnerStatus>) : null))
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 4000)
    return () => clearInterval(timer)
  }, [base])

  const start = async (
    taskId?: string,
  ): Promise<{ ok: true; taskId: string } | { ok: false; error?: string }> => {
    try {
      const res = await fetch(`${base}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(taskId === undefined ? {} : { taskId }),
      })
      refresh()
      if (res.ok) {
        const body = (await res.json()) as { taskId?: string }
        return { ok: true, taskId: body.taskId ?? '' }
      }
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null
      return { ok: false, error: parsed?.error ?? `HTTP ${res.status}` }
    } catch {
      return { ok: false, error: 'could not reach the amagi server' }
    }
  }

  const stop = async (taskId: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`${base}/api/runs/${taskId}/stop`, { method: 'POST' })
      refresh()
      if (res.ok) return { ok: true }
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null
      return { ok: false, error: parsed?.error ?? `HTTP ${res.status}` }
    } catch {
      return { ok: false, error: 'could not reach the amagi server' }
    }
  }

  return <RunnerContext.Provider value={{ status, start, stop }}>{children}</RunnerContext.Provider>
}

export function useRunner(): RunnerApi {
  return useContext(RunnerContext)
}

export function useConnection(): ConnectionStatus {
  return useContext(ConnectionContext)
}
