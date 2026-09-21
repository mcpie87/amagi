import { agentLogStore } from '@amagi/core/agent-log'
import type { StoredEvent } from '@amagi/core/events'
import { type DashboardState, initialDashboardState, reduceState } from '@amagi/core/view'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useState,
} from 'react'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

export type RepoInfo = {
  key: string
  name: string
  path: string
  ready: { name: string; ok: boolean; detail?: string }[]
}

export type DashboardValue = {
  repos: RepoInfo[] | null
  selected: string | null
  selectRepo: (key: string) => void
  refreshRepos: () => void
  addRepo: (path: string) => Promise<RepoInfo | { error: string }>
}

const ReposContext = createContext<DashboardValue>({
  repos: null,
  selected: null,
  selectRepo: () => {},
  refreshRepos: () => {},
  addRepo: async () => ({ error: 'no provider' }),
})

const StreamContext = createContext<DashboardState>(initialDashboardState())

type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting'
const ConnectionContext = createContext<ConnectionStatus>('connecting')

function readStored(): string | null {
  try {
    return localStorage.getItem('amagi:repo')
  } catch {
    return null
  }
}

/**
 * One EventSource per selected repository, replayed from seq 0 and resumed
 * from the browser's Last-Event-ID on reconnect. The reducer state is scoped
 * to the repo (the stream component is keyed by repo, so switching resets it)
 * and agent logs are namespaced by repo, so identical issue ids across repos
 * never collide in the dashboard.
 */
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  const [selected, setSelected] = useState<string | null>(readStored)

  const refreshRepos = useCallback(() => {
    fetch(`${apiBase}/api/repos`)
      .then((res) => (res.ok ? (res.json() as Promise<RepoInfo[]>) : []))
      .then((list) => {
        setRepos(list)
        setSelected((prev) =>
          prev !== null && list.some((r) => r.key === prev) ? prev : (list[0]?.key ?? null),
        )
      })
      .catch(() => setRepos([]))
  }, [])

  useEffect(refreshRepos, [refreshRepos])

  const selectRepo = useCallback((key: string) => {
    setSelected(key)
    try {
      localStorage.setItem('amagi:repo', key)
    } catch {
      // storage unavailable, the choice just won't persist
    }
  }, [])

  const addRepo = useCallback(
    async (path: string): Promise<RepoInfo | { error: string }> => {
      const res = await fetch(`${apiBase}/api/repos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      const body = (await res.json()) as RepoInfo | { error: string }
      if (!res.ok) return body
      await refreshRepos()
      if ('key' in body) selectRepo(body.key)
      return body
    },
    [refreshRepos, selectRepo],
  )

  return (
    <ReposContext.Provider value={{ repos, selected, selectRepo, refreshRepos, addRepo }}>
      {selected === null ? (
        <StreamContext.Provider value={initialDashboardState()}>{children}</StreamContext.Provider>
      ) : (
        <RepoStream key={selected} repo={selected}>
          {children}
        </RepoStream>
      )}
    </ReposContext.Provider>
  )
}

function RepoStream({ repo, children }: { repo: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceState, undefined, initialDashboardState)
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    const source = new EventSource(`${apiBase}/api/repos/${repo}/stream?sinceSeq=0`)
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
          agentLogStore.append(`${repo}/${parsed.taskId}`, parsed.role, parsed.ts, parsed.event)
        } else {
          dispatch(parsed)
        }
      } catch {
        // a malformed event must not drop the stream
      }
    })
    return () => source.close()
  }, [repo])

  return (
    <ConnectionContext.Provider value={connection}>
      <StreamContext.Provider value={state}>{children}</StreamContext.Provider>
    </ConnectionContext.Provider>
  )
}

export function useDashboard(): DashboardValue & { state: DashboardState } {
  return { ...useContext(ReposContext), state: useContext(StreamContext) }
}

export function useConnection(): ConnectionStatus {
  return useContext(ConnectionContext)
}
