import type { AgentEvent, StoredEvent, TaskState } from '@amagi/core/events'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { AgentLogView } from './AgentLogView.tsx'
import { activeTasks, openQuestionsFor, type QuestionView, type TaskView } from './state.ts'
import { useDashboard } from './store.tsx'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

const stateBadge: Record<TaskState, string> = {
  claimed: 'bg-zinc-500',
  worktree_ready: 'bg-sky-600',
  implementing: 'bg-blue-600',
  awaiting_answer: 'bg-amber-500',
  checks: 'bg-violet-600',
  committed: 'bg-cyan-600',
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
        <Link to="/" className="text-lg font-semibold tracking-tight">
          amagi
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  )
}

function QueueView() {
  const state = useDashboard()
  const queue = activeTasks(state)

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Queue</h1>
      {queue.length === 0 ? (
        <p className="text-zinc-500">No active tasks.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
          {queue.map((task) => (
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
      )}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
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
  const agentStarts = state.events.filter(
    (e): e is Extract<StoredEvent, { type: 'agent.started' }> =>
      e.taskId === id && e.type === 'agent.started',
  )
  const agents = [...new Set(agentStarts.map((e) => `${e.role}: ${e.harness}`))].join(', ')
  const usage = agentEvents
    .map((e) => e.event)
    .filter((ev): ev is Extract<AgentEvent, { kind: 'usage' }> => ev.kind === 'usage')
  const effIn = usage.reduce((sum, u) => sum + u.inputTokens, 0)
  const effOut = usage.reduce((sum, u) => sum + u.outputTokens, 0)
  const effCost = usage.reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  const effort =
    usage.length === 0
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
      </div>
      <p className="mt-1 text-sm text-zinc-500">{task.id}</p>

      <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <DetailRow label="tracker" value={task.tracker} />
        <DetailRow label="agent" value={agents || null} />
        <DetailRow label="effort" value={effort} />
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow label="PR" value={task.prUrl} />
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
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})

const routeTree = rootRoute.addChildren([indexRoute, taskRoute])
export const router = createRouter({ routeTree })
