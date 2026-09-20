import { type AgentEvent, isTerminal, type StoredEvent, type TaskState } from '@amagi/core/events'
import {
  activeTasks,
  currentAgentFor,
  openQuestionsFor,
  type QuestionView,
  type TaskView,
  tasksNeedingAttention,
} from '@amagi/core/view'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from '@tanstack/react-router'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AgentLogView } from './AgentLogView.tsx'
import { useDashboard } from './store.tsx'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

type Issue = {
  id: string
  title: string
  description: string
  acceptanceCriteria: string | null
  status: 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number | null
  type: string | null
  assignee: string | null
  labels: string[]
  parent: string | null
}

const PAGE_SIZE = 10

const ISSUE_STATES: Issue['status'][] = ['open', 'in_progress', 'blocked', 'closed']

const columnHeader: Record<Issue['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
}

const columnColor: Record<Issue['status'], string> = {
  open: 'bg-zinc-600',
  in_progress: 'bg-blue-600',
  blocked: 'bg-red-600',
  closed: 'bg-emerald-600',
}

const stateBadge: Record<TaskState, string> = {
  claimed: 'bg-zinc-500',
  worktree_ready: 'bg-sky-600',
  implementing: 'bg-blue-600',
  awaiting_answer: 'bg-amber-500',
  checks: 'bg-violet-600',
  committed: 'bg-cyan-600',
  retrying: 'bg-orange-500',
  pr_open: 'bg-sky-600',
  reviewing: 'bg-purple-600',
  fixing: 'bg-blue-600',
  done: 'bg-emerald-600',
  needs_human: 'bg-red-600',
  abandoned: 'bg-zinc-700',
}

function Badge({ state }: { state: TaskState }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium text-white ${stateBadge[state]}`}
    >
      {state}
    </span>
  )
}

function RootLayout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3">
        <div className="mx-auto flex max-w-5xl items-center gap-5">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            amagi
          </Link>
          <nav className="flex gap-3 text-sm text-zinc-400">
            <Link to="/" activeProps={{ className: 'text-zinc-100' }}>
              Queue
            </Link>
            <Link to="/issues" activeProps={{ className: 'text-zinc-100' }}>
              Tasks
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  )
}

function IssueBadge({ issue }: { issue: Issue }) {
  const color =
    issue.status === 'closed'
      ? 'bg-emerald-600'
      : issue.status === 'blocked'
        ? 'bg-red-600'
        : issue.status === 'in_progress'
          ? 'bg-blue-600'
          : 'bg-zinc-600'
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium text-white ${color}`}>
      {issue.status}
    </span>
  )
}

type IssuesViewMode = 'kanban' | 'list'

function IssuesView() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [selected, setSelected] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Issue['status'] | 'all'>('all')
  const [page, setPage] = useState(0)
  const [view, setView] = useState<IssuesViewMode>(() => {
    try {
      return localStorage.getItem('issues:view') === 'list' ? 'list' : 'kanban'
    } catch {
      // storage unavailable (private mode, blocked), keep the default
      return 'kanban'
    }
  })

  const setMode = (mode: IssuesViewMode) => {
    setView(mode)
    try {
      localStorage.setItem('issues:view', mode)
    } catch {
      // storage unavailable, the choice just won't persist
    }
  }

  useEffect(() => {
    fetch(`${apiBase}/api/issues`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then(setIssues)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const filtered = status === 'all' ? issues : issues.filter((issue) => issue.status === status)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  if (selected !== null) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="text-sm text-sky-400 hover:underline"
        >
          &larr; tasks
        </button>
        <div className="mt-3 flex items-center gap-3">
          <h1 className="text-xl font-semibold">{selected.title}</h1>
          <IssueBadge issue={selected} />
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {selected.id}
          {selected.parent ? ` · child of ${selected.parent}` : ''}
        </p>
        <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <DetailRow
            label="priority"
            value={selected.priority === null ? null : `P${selected.priority}`}
          />
          <DetailRow label="type" value={selected.type} />
          <DetailRow label="assignee" value={selected.assignee} />
          <DetailRow label="labels" value={selected.labels.join(', ') || null} />
        </dl>
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Description
          </h2>
          <p className="whitespace-pre-wrap text-zinc-300">
            {selected.description || 'No description.'}
          </p>
        </div>
        {selected.acceptanceCriteria !== null && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Acceptance criteria
            </h2>
            <p className="whitespace-pre-wrap text-zinc-300">{selected.acceptanceCriteria}</p>
          </div>
        )}
      </section>
    )
  }
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-500">
            {issues.length} {issues.length === 1 ? 'task' : 'tasks'}
            {status !== 'all' && ` · ${filtered.length} shown`}
          </span>
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            <button
              type="button"
              onClick={() => setMode('kanban')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'kanban'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Kanban
            </button>
            <button
              type="button"
              onClick={() => setMode('list')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'list' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              List
            </button>
          </div>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status)
              setPage(0)
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>
      {error !== null ? (
        <p className="text-red-400">{error}</p>
      ) : view === 'kanban' ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {ISSUE_STATES.map((state) => {
            if (status !== 'all' && status !== state) return null
            const columnIssues = filtered.filter((issue) => issue.status === state)
            return (
              <div
                key={state}
                className="flex h-[70vh] w-72 shrink-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
                  <span
                    className={`truncate rounded px-2 py-0.5 text-xs font-medium text-white ${columnColor[state]}`}
                  >
                    {columnHeader[state]}
                  </span>
                  <span className="text-xs text-zinc-500">{columnIssues.length}</span>
                </div>
                <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {columnIssues.map((issue) => (
                    <li key={issue.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(issue)}
                        className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-left hover:bg-zinc-800"
                      >
                        <span className="block text-xs text-zinc-500">{issue.id}</span>
                        <span className="mt-0.5 block break-words font-medium leading-snug">
                          {issue.title}
                        </span>
                        <span className="mt-1 block text-xs text-zinc-500">
                          {[issue.priority === null ? null : `P${issue.priority}`, issue.type]
                            .filter(Boolean)
                            .join(' · ') || '\u00a0'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {columnIssues.length === 0 && (
                    <li className="px-1 py-2 text-xs text-zinc-600">No tasks.</li>
                  )}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
            {pageItems.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  onClick={() => setSelected(issue)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800"
                >
                  <IssueBadge issue={issue} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{issue.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {issue.id}
                      {issue.priority === null ? '' : ` · P${issue.priority}`}
                      {issue.type === null ? '' : ` · ${issue.type}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
              >
                &larr; prev
              </button>
              <span className="text-sm text-zinc-500">
                page {currentPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
                className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
              >
                next &rarr;
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function QueueView() {
  const state = useDashboard()
  const queue = activeTasks(state)
  const attention = tasksNeedingAttention(state)

  const taskList = (tasks: TaskView[]) => (
    <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
      {tasks.map((task) => (
        <li key={task.id}>
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-800"
          >
            <Badge state={task.state} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{task.title}</span>
              <span className="block truncate text-xs text-zinc-500">
                {task.id}
                {task.reviewRound > 0 ? ` · review round ${task.reviewRound}` : ''}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Queue</h1>
      {attention.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-400">
            Needs attention ({attention.length})
          </h2>
          {taskList(attention)}
        </div>
      )}
      {queue.length === 0 ? <p className="text-zinc-500">No active tasks.</p> : taskList(queue)}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string | ReactNode | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function ForgejoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M16.7773 0c1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.1175a7.0759 7.0759 0 0 1 4.148-1.4205l.1176-.001 1.3385.0002c.4973-.8827 1.4434-1.4788 2.5288-1.4788 1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.319c.8827.4973 1.4788 1.4434 1.4788 2.5287 0 1.602-1.2986 2.9005-2.9005 2.9005-1.6018 0-2.9004-1.2986-2.9004-2.9005 0-1.0853.596-2.0314 1.4788-2.5287l-.0002-9.9831c0-3.887 3.1195-7.0453 6.9915-7.108l.1176-.001h1.3385C14.7458.5962 15.692 0 16.7773 0ZM7.2227 19.9052c-.6596 0-1.1943.5347-1.1943 1.1943s.5347 1.1943 1.1943 1.1943 1.1944-.5347 1.1944-1.1943-.5348-1.1943-1.1944-1.1943Zm9.5546-10.4644c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Zm0-7.7346c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Z" />
    </svg>
  )
}

function PrLink({ url }: { url: string }) {
  const isGithub = new URL(url).hostname.endsWith('github.com')
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-sky-400 hover:underline"
    >
      {isGithub ? <GithubIcon className="h-4 w-4" /> : <ForgejoIcon className="h-4 w-4" />}
      {url}
    </a>
  )
}

function AnswerBox({ taskId, question }: { taskId: string; question: QuestionView }) {
  const [token, setToken] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${apiBase}/api/tasks/${taskId}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ token?: string }>) : null))
      .then((body) => {
        if (alive) setToken(body?.token ?? null)
      })
      .catch(() => {
        if (alive) setToken(null)
      })
    return () => {
      alive = false
    }
  }, [taskId])

  const send = async (answer: string) => {
    if (token === null || answer.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/tasks/${taskId}/questions/${question.id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
        body: JSON.stringify({ answer, via: 'web' }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send(text)
  }

  if (token === null) {
    return <p className="mt-2 text-sm text-zinc-500">answer box unavailable</p>
  }

  return (
    <div className="mt-2">
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send(option)}
              className="rounded border border-amber-700 bg-amber-900/40 px-3 py-1 text-sm hover:bg-amber-800 disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="answer"
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-zinc-950 disabled:opacity-50"
        >
          Answer
        </button>
      </form>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

function ReclaimButton({
  taskId,
  state,
  worktree,
}: {
  taskId: string
  state: TaskState
  worktree: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (worktree === null || isTerminal(state)) return null

  const reclaim = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/tasks/${taskId}/reclaim`, { method: 'POST' })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void reclaim()}
        className="rounded border border-red-800 bg-red-950/40 px-3 py-1 text-sm text-red-300 hover:bg-red-900 disabled:opacity-50"
      >
        Reclaim
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

type AgentStreamEvent = Extract<StoredEvent, { type: 'agent.stream' }>

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function lineFor(event: AgentStreamEvent): string {
  const ev = event.event
  switch (ev.kind) {
    case 'text':
    case 'reasoning':
      return ev.text
    case 'tool_use':
      return `[tool] ${ev.name}`
    case 'tool_result':
      return `[${ev.ok ? 'ok' : 'FAIL'}] ${ev.name}`
    case 'usage':
      return `[usage] in=${ev.inputTokens} out=${ev.outputTokens}`
    case 'result':
      return `[result] ${ev.summary ?? (ev.ok ? 'ok' : 'failed')}`
    case 'error':
      return `[error] ${ev.message}`
  }
}

/** Plain recent log. The virtualization task (am-b2z.4) replaces this. */
function AgentLog({ events }: { events: AgentStreamEvent[] }) {
  const ref = useRef<HTMLDivElement>(null)
  // no deps on purpose: tail the log after every render, not just on mount
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })
  return (
    <div
      ref={ref}
      className="max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300"
    >
      {events.map((e) => (
        <div key={e.seq} className="whitespace-pre-wrap break-words">
          {lineFor(e)}
        </div>
      ))}
    </div>
  )
}

function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const state = useDashboard()
  const task: TaskView | undefined = state.tasks[id]
  const questions = openQuestionsFor(state, id)
  // ponytail: last 500 rendered, the virtualization task (am-b2z.4) removes the cap
  const agentEvents = state.events
    .filter((e): e is AgentStreamEvent => e.taskId === id && e.type === 'agent.stream')
    .slice(-500)
  const currentAgent = currentAgentFor(state, id)
  const usageEvents = agentEvents
    .map((e) => e.event)
    .filter((ev): ev is Extract<AgentEvent, { kind: 'usage' }> => ev.kind === 'usage')
  const effIn = usageEvents.reduce((sum, u) => sum + u.inputTokens, 0)
  const effOut = usageEvents.reduce((sum, u) => sum + u.outputTokens, 0)
  const effCost = usageEvents.reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  const usage =
    usageEvents.length === 0
      ? 'no usage reported yet'
      : `${fmtTokens(effIn)} in · ${fmtTokens(effOut)} out` +
        (effCost > 0 ? ` · $${effCost.toFixed(2)}` : '')

  if (!task) {
    return (
      <section>
        <Link to="/" className="text-sm text-sky-400 hover:underline">
          &larr; queue
        </Link>
        <p className="mt-4 text-zinc-500">No events yet for {id}.</p>
      </section>
    )
  }

  return (
    <section>
      <Link to="/" className="text-sm text-sky-400 hover:underline">
        &larr; queue
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <Badge state={task.state} />
        {task.reviewRound > 0 && (
          <span className="text-sm text-zinc-400">review round {task.reviewRound}</span>
        )}
        <ReclaimButton taskId={task.id} state={task.state} worktree={task.worktree} />
      </div>
      <p className="mt-1 text-sm text-zinc-500">{task.id}</p>

      <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <DetailRow label="tracker" value={task.tracker} />
        <DetailRow
          label="agent"
          value={currentAgent ? `${currentAgent.role}: ${currentAgent.harness}` : null}
        />
        <DetailRow label="model" value={currentAgent?.model ?? 'unknown'} />
        <DetailRow label="effort" value={currentAgent?.effort ?? 'unknown'} />
        <DetailRow label="usage" value={usage} />
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow label="PR" value={task.prUrl === null ? null : <PrLink url={task.prUrl} />} />
        {task.lastCommit !== null && (
          <DetailRow
            label="commit"
            value={`${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.subject}`}
          />
        )}
        <DetailRow label="session" value={task.sessionId} />
        <DetailRow label="error" value={task.lastError} />
      </dl>

      <AgentLogView taskId={id} />

      {questions.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Questions
          </h2>
          <ul className="space-y-2">
            {questions.map((q) => (
              <li
                key={q.id}
                className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3"
              >
                <p className="font-medium">{q.question}</p>
                <AnswerBox taskId={id} question={q} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {agentEvents.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Agent output
          </h2>
          <AgentLog events={agentEvents} />
        </div>
      )}

      {task.checks !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Checks {task.checksOk ? '(passed)' : '(failed)'}
          </h2>
          <ul className="space-y-2">
            {task.checks.map((c) => (
              <li
                key={c.command}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
              >
                <p className="font-mono text-sm">
                  <span className={c.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                    exit {c.exitCode}
                  </span>{' '}
                  {c.command}
                </p>
                {c.output !== '' && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-xs text-zinc-400">
                    {c.output}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: QueueView })
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues',
  component: IssuesView,
})
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})

const routeTree = rootRoute.addChildren([indexRoute, issuesRoute, taskRoute])
export const router = createRouter({ routeTree })
