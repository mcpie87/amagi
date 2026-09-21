import { agentLogStore, type DashboardState, initialDashboardState, reduceState } from '@amagi/core'
import { useEffect, useReducer, useRef } from 'react'
import { subscribeToStream } from './stream.ts'

/**
 * The terminal counterpart of the dashboard's DashboardProvider: replays
 * `/api/stream` from seq 0 through the same reducer, so the queue and task
 * detail views fold to identical state regardless of which client is
 * watching. agent.stream still bypasses the reducer into agentLogStore, for
 * the same reason the browser does: it is the hot path and must never cost a
 * render per line. Components that show the log read agentLogStore directly.
 */
export function useDashboardStream(baseUrl: string, taskId?: string): DashboardState {
  const [state, dispatch] = useReducer(reduceState, undefined, initialDashboardState)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const handle = subscribeToStream(baseUrl, taskId !== undefined ? { taskId } : {}, (event) => {
      if (!mounted.current) return
      if (event.type === 'agent.stream' && event.taskId !== null) {
        agentLogStore.append(event.taskId, event.role, event.ts, event.event)
      } else {
        dispatch(event)
      }
    })
    return () => {
      mounted.current = false
      handle.close()
    }
  }, [baseUrl, taskId])

  return state
}
