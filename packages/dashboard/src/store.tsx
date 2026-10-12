import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
import type { TrackerTask } from '@amagi/core/drivers/types'
import type { StoredEvent } from '@amagi/core/events'
import type { RunnerStatus } from '@amagi/core/run-service'
import { type DashboardState, initialDashboardState, reduceBatch } from '@amagi/core/view'
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
import {
  followRepo,
  pollOk,
  refreshPoll,
  resyncRepo,
  type StreamStatus,
  usePoll,
} from './hub-client.ts'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

export type RepoInfo = {
  key: string
  name: string
  path: string
  /** Whether the server's auto-queue may claim work from this repo. */
  workers: boolean
  /** Whether the server runs background pollers and watchers for this repo. */
  watchers: boolean
  ready: { name: string; ok: boolean; detail?: string }[]
}

/** Failed readiness checks: a repo with any of these cannot run work and needs the operator. */
export function repoBlockers(repo: RepoInfo): RepoInfo['ready'] {
  return repo.ready.filter((check) => !check.ok)
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

/**
 * The seq the selected repo's compact replay covered, or null until it
 * finishes. Agent log lines up to it are fetched per task; later ones stream.
 */
const ReplayContext = createContext<{ repo: string; seq: number | null } | null>(null)

const ConnectionContext = createContext<StreamStatus>('connecting')

function readStored(): string | null {
  try {
    return localStorage.getItem('amagi:repo')
  } catch {
    return null
  }
}

const reposUrl = `${apiBase}/api/repos`
const refreshRepos = () => refreshPoll(reposUrl)
const noTasks: TrackerTask[] = []

/**
 * One event stream per selected repository, shared by every tab through the
 * hub (hub.ts), replayed from seq 0 without agent log lines (log views
 * backfill those per task, see useAgentLogBackfill). The reducer state is
 * scoped to the repo (the stream component is keyed by repo, so switching
 * resets it) and agent logs are namespaced by repo, so identical issue ids
 * across repos never collide in the dashboard.
 */
export function DashboardProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  const [selected, setSelected] = useState<string | null>(readStored)
  const resyncStream = useCallback(() => {
    if (selected !== null) resyncRepo(selected)
  }, [selected])

  // Polled because a repo can break (config edited, remote changed) while the dashboard is open.
  const reposPoll = usePoll(reposUrl, 15_000)
  useEffect(() => {
    if (reposPoll === undefined) return
    const list = pollOk(reposPoll) ? (reposPoll.body as RepoInfo[]) : []
    setRepos(list)
    setSelected((prev) =>
      prev !== null && list.some((r) => r.key === prev) ? prev : (list[0]?.key ?? null),
    )
  }, [reposPoll])

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
      refreshRepos()
      if ('key' in body) selectRepo(body.key)
      return body
    },
    [selectRepo],
  )

  return (
    <ReposContext.Provider
      value={{ repos, selected, selectRepo, refreshRepos, addRepo, resyncStream }}
    >
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
  const [state, dispatch] = useReducer(reduceBatch, undefined, initialDashboardState)
  const queuePoll = usePoll(`${apiBase}/api/repos/${repo}/ready-queue`, 4000)
  const readyQueue = pollOk(queuePoll) ? (queuePoll.body as TrackerTask[]) : noTasks
  const [connection, setConnection] = useState<StreamStatus>('connecting')
  const latestSeqRef = useRef(0)
  const attemptsRef = useRef(new Map<string, number>())
  const replayedRef = useRef<number | null>(null)
  const [replayed, setReplayed] = useState<number | null>(null)

  useEffect(() => {
    agentLogStore.clear(`${repo}/`)
    forgetBackfills(repo)
    // A replay delivers tens of thousands of events back to back; one dispatch
    // each meant one full render each. Queue them and fold once per frame.
    let pending: StoredEvent[] = []
    let frame: number | null = null
    const flush = () => {
      frame = null
      if (pending.length === 0) return
      const batch = pending
      pending = []
      dispatch(batch)
    }
    const enqueue = (event: StoredEvent) => {
      pending.push(event)
      frame ??= requestAnimationFrame(flush)
    }
    const receive = (data: string) => {
      try {
        const parsed = JSON.parse(data) as StoredEvent
        if (parsed.type === 'notify.idle') {
          window.dispatchEvent(
            new CustomEvent('amagi:idle-notification', {
              detail: { title: parsed.title, body: parsed.body },
            }),
          )
        }
        if (parsed.type === 'notify.failed' && parsed.channel === 'libnotify') {
          window.dispatchEvent(
            new CustomEvent('amagi:desktop-notification-failure', {
              detail: { title: parsed.title, body: parsed.detail },
            }),
          )
        }
        if (parsed.seq <= latestSeqRef.current) return
        latestSeqRef.current = parsed.seq
        // agent.stream is the hot path: hundreds of lines/sec of assistant
        // text and tool output. It bypasses the reducer entirely so it never
        // costs a setState per line; the ring buffer in agentLog.ts owns it
        // and batches renders on requestAnimationFrame instead.
        if (parsed.type === 'task.reset' && parsed.taskId !== null) {
          const attempts = attemptsRef.current
          attempts.set(parsed.taskId, (attempts.get(parsed.taskId) ?? 1) + 1)
        }
        if (parsed.type === 'agent.stream') {
          // Lines up to the replayed seq come from the per-task backfill.
          const live = replayedRef.current !== null && parsed.seq > replayedRef.current
          if (parsed.taskId !== null && live) {
            const attempt = attemptsRef.current.get(parsed.taskId) ?? 1
            agentLogStore.append(
              agentLogKey(repo, parsed.taskId, attempt),
              parsed.role,
              parsed.ts,
              parsed.event,
            )
          }
          // Keep sparse usage for sessions, and task chat output for the chat
          // panel. Null-task watcher text and tool events stay out of state.
          if (parsed.event.kind === 'usage' || (parsed.taskId !== null && parsed.role === 'chat'))
            enqueue(parsed)
        } else {
          enqueue(parsed)
        }
      } catch {
        // a malformed event must not drop the stream
      }
    }
    const unfollow = followRepo(repo, {
      status: setConnection,
      events: (data) => {
        for (const item of data) receive(item)
      },
      replayed: (seq) => {
        replayedRef.current = seq
        setReplayed(seq)
      },
    })
    return () => {
      unfollow()
      if (frame !== null) cancelAnimationFrame(frame)
      flush()
    }
  }, [repo])

  return (
    <ConnectionContext.Provider value={connection}>
      <ReplayContext.Provider value={{ repo, seq: replayed }}>
        <StreamContext.Provider value={state}>
          <ReadyQueueContext.Provider value={readyQueue}>{children}</ReadyQueueContext.Provider>
        </StreamContext.Provider>
      </ReplayContext.Provider>
    </ConnectionContext.Provider>
  )
}

/** The replayed seq each agent log buffer was backfilled up to. */
const backfills = new Map<string, number>()

function forgetBackfills(repo: string): void {
  for (const key of backfills.keys()) if (key.startsWith(`${repo}/`)) backfills.delete(key)
}

/**
 * Fills a task's agent log buffer with the lines the compact replay left out.
 * A repo other than the streamed one has no live lines, so it gets everything
 * stored so far.
 */
export function useAgentLogBackfill(repo: string, taskId: string, attempt: number): void {
  const replay = useContext(ReplayContext)
  const untilSeq = replay === null || replay.repo !== repo ? Number.MAX_SAFE_INTEGER : replay.seq
  useEffect(() => {
    if (untilSeq === null) return
    const key = agentLogKey(repo, taskId, attempt)
    if (backfills.get(key) === untilSeq) return
    backfills.set(key, untilSeq)
    fetch(
      `${apiBase}/api/repos/${repo}/tasks/${encodeURIComponent(taskId)}/agent-log?attempt=${attempt}&untilSeq=${untilSeq}`,
    )
      .then((res) => (res.ok ? (res.json() as Promise<StoredEvent[]>) : []))
      .then((events) => {
        // A reconnect since the request cleared the buffer and asked again.
        if (backfills.get(key) !== untilSeq) return
        agentLogStore.backfill(
          key,
          events.flatMap((event) => (event.type === 'agent.stream' ? [event] : [])),
        )
      })
      .catch(() => backfills.delete(key))
  }, [repo, taskId, attempt, untilSeq])
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
  const runnerUrl = selected === null ? null : `${base}/api/repos/${selected}/runner`
  const runnerPoll = usePoll(runnerUrl, 4000)
  const status = pollOk(runnerPoll) ? (runnerPoll.body as RunnerStatus) : null
  const [options, setOptions] = useState<RunOptionsInfo | null>(null)

  const refresh = () => {
    if (runnerUrl !== null) refreshPoll(runnerUrl)
  }

  useEffect(() => {
    setOptions(null)
    if (selected === null) return
    let alive = true
    fetch(`${base}/api/repos/${selected}/runner/options`)
      .then((r) => (r.ok ? (r.json() as Promise<RunOptionsInfo>) : null))
      .then((value) => {
        if (alive) setOptions(value)
      })
      .catch(() => {
        if (alive) setOptions(null)
      })
    return () => {
      alive = false
    }
  }, [selected])

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

export function useConnection(): StreamStatus {
  return useContext(ConnectionContext)
}

export type SeatState = {
  seat: string
  state: 'free' | 'held'
  holder: {
    repo: string
    taskId?: string
    title?: string
    watcher?: string
    status?: string
    since?: number | null
  } | null
  waiters: { repo: string; taskId: string; title: string; status: string; since: number | null }[]
  eligible: { repo: string; taskId: string; title: string; status: string; since: number | null }[]
}

/** Global seat state is polled independently of the selected repository stream. */
export function useSeats(): SeatState[] | null {
  const seats = usePoll(`${apiBase}/api/seats`, 4000)
  return pollOk(seats) ? (seats.body as { seats: SeatState[] }).seats : null
}
