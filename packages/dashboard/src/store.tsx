import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
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
  useRef,
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
  /**
   * Reconnects the selected repo's event stream from the last event the client
   * saw. The SSE connection can silently go stale (e.g. a dev proxy holding a
   * dead upstream after a server restart), so mutations that must be reflected
   * promptly re-sync instead of waiting for a page refresh.
   */
  resyncStream: () => void
}

const ReposContext = createContext<DashboardValue>({
  repos: null,
  selected: null,
  selectRepo: () => {},
  refreshRepos: () => {},
  addRepo: async () => ({ error: 'no provider' }),
  resyncStream: () => {},
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
  const [resync, setResync] = useState(0)
  const resyncStream = useCallback(() => setResync((n) => n + 1), [])

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
    <ReposContext.Provider
      value={{ repos, selected, selectRepo, refreshRepos, addRepo, resyncStream }}
    >
      {selected === null ? (
        <StreamContext.Provider value={initialDashboardState()}>{children}</StreamContext.Provider>
      ) : (
        <RepoStream key={selected} repo={selected} resync={resync}>
          {children}
        </RepoStream>
      )}
    </ReposContext.Provider>
  )
}

function RepoStream({
  repo,
  resync,
  children,
}: {
  repo: string
  resync: number
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reduceState, undefined, initialDashboardState)
  const [readyQueue, setReadyQueue] = useState<TrackerTask[]>([])
  const [connection, setConnection] = useState<ConnectionStatus>('connecting')
  const latestSeqRef = useRef(0)
  latestSeqRef.current = state.latestSeq
  // Survives reconnects, which only replay missed events, so a resumed stream
  // keeps counting resets from where the first connection left off.
  const attemptsRef = useRef(new Map<string, number>())

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
    // Resync resumes from the last event the client already folded in, so a
    // reconnection only replays what the stale connection missed. The first
    // connect replays everything (latestSeq is 0).
    void resync
    const source = new EventSource(
      `${apiBase}/api/repos/${repo}/stream?sinceSeq=${latestSeqRef.current}`,
    )
    source.addEventListener('open', () => setConnection('connected'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('message', (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as StoredEvent
        // agent.stream is the hot path: hundreds of lines/sec of assistant
        // text and tool output. It bypasses the reducer entirely so it never
        // costs a setState per line; the ring buffer in agentLog.ts owns it
        // and batches renders on requestAnimationFrame instead.
        if (parsed.type === 'task.reset' && parsed.taskId !== null) {
          const attempts = attemptsRef.current
          attempts.set(parsed.taskId, (attempts.get(parsed.taskId) ?? 1) + 1)
        }
        if (parsed.type === 'agent.stream' && parsed.taskId !== null) {
          const attempt = attemptsRef.current.get(parsed.taskId) ?? 1
          agentLogStore.append(
            agentLogKey(repo, parsed.taskId, attempt),
            parsed.role,
            parsed.ts,
            parsed.event,
          )
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
  }, [repo, resync])

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
  /** Choices for the Run next picker, or null before the first fetch. */
  options: RunOptionsInfo | null
  start: (
    taskId?: string,
    opts?: RunOptions,
  ) => Promise<{ ok: true; taskId: string } | { ok: false; error?: string }>
  stop: (taskId: string) => Promise<{ ok: boolean; error?: string }>
}

/** Per-launch overrides, matching RunBody. Omitted fields use config defaults. */
export type RunOptions = {
  harness?: string
  model?: string
  effort?: string
}

export type RunOptionsInfo = {
  harnesses: { name: string; kind: string; model?: string; effort?: string }[]
  models: Record<string, string[]>
  efforts: Record<string, string[]>
  /** The configured default harness (config.harness.implement), for labeling. */
  default: { kind: string; model?: string; effort?: string } | null
}

const RunnerContext = createContext<RunnerApi>({
  status: null,
  options: null,
  start: async () => ({ ok: false }),
  stop: async () => ({ ok: false }),
})

/** Runner availability plus launch/stop, polled so the header stays honest. */
export function RunnerProvider({ children }: { children: ReactNode }) {
  const base = (import.meta.env.VITE_API_BASE ?? '') as string
  const { resyncStream, selected } = useContext(ReposContext)
  const [status, setStatus] = useState<RunnerStatus | null>(null)
  const [options, setOptions] = useState<RunOptionsInfo | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const refresh = useCallback(() => {
    if (selected === null) {
      setStatus(null)
      return
    }
    const repo = selected
    fetch(`${base}/api/repos/${selected}/runner`)
      .then((r) => (r.ok ? (r.json() as Promise<RunnerStatus>) : null))
      .then((value) => {
        if (selectedRef.current === repo) setStatus(value)
      })
      .catch(() => {
        if (selectedRef.current === repo) setStatus(null)
      })
  }, [base, selected])

  useEffect(() => {
    setStatus(null)
    setOptions(null)
    refresh()
    if (selected === null) {
      setOptions(null)
      return
    }
    let alive = true
    fetch(`${base}/api/repos/${selected}/runner/options`)
      .then((r) => (r.ok ? (r.json() as Promise<RunOptionsInfo>) : null))
      .then((value) => {
        if (alive) setOptions(value)
      })
      .catch(() => {
        if (alive) setOptions(null)
      })
    const timer = setInterval(refresh, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [base, refresh, selected])

  const start = async (
    taskId?: string,
    opts?: RunOptions,
  ): Promise<{ ok: true; taskId: string } | { ok: false; error?: string }> => {
    if (selected === null) return { ok: false, error: 'select a repository first' }
    try {
      const res = await fetch(`${base}/api/repos/${selected}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(taskId === undefined ? {} : { taskId }),
          ...(opts?.harness === undefined ? {} : { harness: opts.harness }),
          ...(opts?.model === undefined ? {} : { model: opts.model }),
          ...(opts?.effort === undefined ? {} : { effort: opts.effort }),
        }),
      })
      refresh()
      // The launch lands in the store only after this request; if the event
      // stream is stale the new task's title/agent never arrive, so force a
      // resync instead of leaving the worker slot showing a bare task id.
      resyncStream()
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
    if (selected === null) return { ok: false, error: 'select a repository first' }
    try {
      const res = await fetch(`${base}/api/repos/${selected}/runs/${taskId}/stop`, {
        method: 'POST',
      })
      refresh()
      resyncStream()
      if (res.ok) return { ok: true }
      const parsed = (await res.json().catch(() => null)) as { error?: string } | null
      return { ok: false, error: parsed?.error ?? `HTTP ${res.status}` }
    } catch {
      return { ok: false, error: 'could not reach the amagi server' }
    }
  }

  return (
    <RunnerContext.Provider value={{ status, options, start, stop }}>
      {children}
    </RunnerContext.Provider>
  )
}

export function useRunner(): RunnerApi {
  return useContext(RunnerContext)
}

export function useConnection(): ConnectionStatus {
  return useContext(ConnectionContext)
}
