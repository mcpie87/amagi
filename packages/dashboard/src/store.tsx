import type { StoredEvent } from '@amagi/core/events'
import { createContext, type ReactNode, useContext, useEffect, useReducer } from 'react'
import { agentLogStore } from './agentLog.ts'
import { type DashboardState, initialDashboardState, reduceState } from './state.ts'

const DashboardContext = createContext<DashboardState>(initialDashboardState())

/**
 * One EventSource carries the whole store. The server replays from
 * `sinceSeq` and honours the browser's Last-Event-ID on reconnect, so a page
 * reload reconstructs identical state by folding the replay back over the
 * reducer. No query cache: the API list endpoints are not consulted.
 */
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceState, undefined, initialDashboardState)

  useEffect(() => {
    const base = (import.meta.env.VITE_API_BASE ?? '') as string
    const source = new EventSource(`${base}/api/stream?sinceSeq=0`)
    source.addEventListener('message', (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as StoredEvent
        // agent.stream is the hot path: hundreds of lines/sec of assistant
        // text and tool output. It bypasses the reducer entirely so it never
        // costs a setState per line; the ring buffer in agentLog.ts owns it
        // and batches renders on requestAnimationFrame instead.
        if (parsed.type === 'agent.stream' && parsed.taskId !== null) {
          agentLogStore.append(parsed.taskId, parsed.role, parsed.ts, parsed.event)
        } else {
          dispatch(parsed)
        }
      } catch {
        // a malformed event must not drop the stream
      }
    })
    return () => source.close()
  }, [])

  return <DashboardContext.Provider value={state}>{children}</DashboardContext.Provider>
}

export function useDashboard(): DashboardState {
  return useContext(DashboardContext)
}
