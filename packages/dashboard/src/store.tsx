import { agentLogStore } from '@amagi/core/agent-log'
import type { TrackerTask } from '@amagi/core/drivers/types'
import type { StoredEvent } from '@amagi/core/events'
import type { RunnerStatus } from '@amagi/core/run-service'
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

/** The repo's unclaimed ready queue, FCFS from the tracker. */
const ReadyQueueContext = createContext<TrackerTask[]>([])

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
  const [readyQueue, setReadyQueue] = useState<TrackerTask[]>([])
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch(`${apiBase}/api/repos/${repo}/ready-queue`)
        .then((res) => (res.ok ? (res.json() as Promise<TrackerTask[]>) : []))
        .then((tasks) => {
          if (alive) setReadyQueue(tasks)
        })
        .catch(() => {
          if (alive) setReadyQueue([])
        })
    }
    load()
    const timer = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [repo])

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
          // usage is sparse (one per step/turn, not per line): the only
          // agent.stream event the reducer needs, for the sessions view.
          if (parsed.event.kind === 'usage') dispatch(parsed)
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
      <StreamContext.Provider value={state}>
        <ReadyQueueContext.Provider value={readyQueue}>{children}</ReadyQueueContext.Provider>
      </StreamContext.Provider>
    </ConnectionContext.Provider>
  )
}

export function useDashboard(): DashboardValue & { state: DashboardState } {
  return { ...useContext(ReposContext), state: useContext(StreamContext) }
}

/** The repo's unclaimed ready queue, first-created first. */
export function useReadyQueue(): TrackerTask[] {
  return useContext(ReadyQueueContext)
}

export type RunnerApi = {
  status: RunnerStatus | null
  stop: (taskId: string) => Promise<{ ok: boolean; error?: string }>
}

const RunnerContext = createContext<RunnerApi>({
  status: null,
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

  return <RunnerContext.Provider value={{ status, stop }}>{children}</RunnerContext.Provider>
}

export function useRunner(): RunnerApi {
  return useContext(RunnerContext)
}

export function useConnection(): ConnectionStatus {
  return useContext(ConnectionContext)
}
