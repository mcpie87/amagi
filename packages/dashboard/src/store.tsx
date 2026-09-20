import type { StoredEvent } from '@amagi/core/events'
import { createContext, type ReactNode, useContext, useEffect, useReducer } from 'react'
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
        dispatch(JSON.parse(event.data) as StoredEvent)
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
