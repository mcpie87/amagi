import { chatInFlight, chatTurns, type ProjectedTask } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { gitCommitRoute, taskRoute } from '../routes.tsx'
import { useDashboard } from '../store.tsx'

/**
 * Operator/worker chat on a parked no_pr task. Each message resumes the task's
 * recorded session in its worktree; the answer streams in through the repo
 * event stream, so this component only renders what chatTurns folds from it.
 * A settled task (e.g. marked done) keeps the conversation read-only so it is
 * not lost on completion, while the send form only shows while the task is a
 * chattable no_pr run with a session and worktree to resume.
 */
export function ChatPanel({ repo, taskId }: { repo: string; taskId: string }) {
  const { state } = useDashboard()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const task = state.tasks[taskId]
  const interactive =
    task !== undefined &&
    task.state === 'no_pr' &&
    task.statusReason !== null &&
    task.sessionId !== null &&
    task.worktree !== null
  const messages = useMemo(() => chatTurns(state, taskId), [state, taskId])
  const responding = useMemo(() => chatInFlight(state, taskId), [state, taskId])
  const scrollRef = useRef<HTMLDivElement>(null)
  // Tail the conversation after every render, like the agent log.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  })

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (message === '' || responding || !interactive) return
    setError(null)
    setText('')
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
        Chat with worker
      </h2>
      <div
        ref={scrollRef}
        className="mb-3 max-h-80 space-y-2 overflow-auto rounded-lg border border-line bg-sunken p-3"
      >
        {messages.length === 0 && interactive && (
          <p className="text-sm text-fg-faint">Ask the worker about why there is no PR.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'ml-auto bg-accent text-on-solid'
                : 'mr-auto border border-line-strong bg-raised text-fg'
            }`}
          >
            {m.role === 'user' ? (
              m.text
            ) : m.pending ? (
              `${m.text === '' ? 'worker is responding' : m.text}...`
            ) : (
              <ChatReply text={m.text} tasks={state.tasks} repo={repo} />
            )}
          </div>
        ))}
      </div>
      {interactive ? (
        <form onSubmit={send} className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={responding}
            placeholder={responding ? 'worker is responding...' : 'ask the worker'}
            className="flex-1 rounded border border-line-strong bg-sunken px-3 py-1 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={responding || text.trim() === ''}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-on-solid hover:bg-accent/90 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      ) : (
        <p className="text-xs text-fg-faint">Conversation preserved; the task is settled.</p>
      )}
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

function ChatReply({
  text,
  tasks,
  repo,
}: {
  text: string
  tasks: Record<string, ProjectedTask>
  repo: string | null
}) {
  let content: unknown = text
  let structured = false
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      content = parsed
      structured = true
    }
  } catch {
    // Plain worker prose remains unchanged.
  }

  const taskIds = Object.keys(tasks).sort((a, b) => b.length - a.length)
  const references = [...taskIds.map(escapeRegExp), '[a-f0-9]{7,40}'].join('|')
  const linkedText = (value: string): ReactNode => {
    const pattern = new RegExp(`(?<![a-z0-9_.-])(${references})(?![a-z0-9_.-])`, 'gi')
    const parts = value.split(pattern)
    return parts.map((part, index) => {
      const task = tasks[part]
      if (task !== undefined) {
        // biome-ignore lint/suspicious/noArrayIndexKey: the same reference can repeat within one text.
        return <TaskReference key={`${part}-${index}`} task={task} />
      }
      if (/^[a-f0-9]{7,40}$/i.test(part)) {
        // biome-ignore lint/suspicious/noArrayIndexKey: the same reference can repeat within one text.
        return <CommitReference key={`${part}-${index}`} hash={part} repo={repo} />
      }
      return part
    })
  }
  const renderValue = (value: unknown): ReactNode => {
    if (typeof value === 'string') return linkedText(value)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value === null) return 'None'
    if (Array.isArray(value))
      return value.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: agent output values are plain data with no identity.
        <div key={index} className="ml-3">
          {renderValue(item)}
        </div>
      ))
    if (typeof value === 'object')
      return (
        <div className="space-y-1">
          {Object.entries(value).map(([key, item]) => (
            <div key={key}>
              <span className="font-medium text-fg-muted">{humanizeKey(key)}:</span>{' '}
              {renderValue(item)}
            </div>
          ))}
        </div>
      )
    return String(value)
  }
  return structured ? (
    <div className="space-y-1">{renderValue(content)}</div>
  ) : (
    <span>{linkedText(text)}</span>
  )
}

function ReferencePopover({
  label,
  children,
  onOpen,
}: {
  label: string
  children: ReactNode
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const popupId = useId()
  return (
    <span className="relative inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Preview ${label}`}
        aria-expanded={open}
        aria-controls={popupId}
        onClick={() => {
          if (!open) onOpen?.()
          setOpen(!open)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className="rounded px-0.5 text-xs text-fg-faint hover:bg-surface-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-ink"
      >
        ⓘ
      </button>
      {open && (
        <span
          id={popupId}
          className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-line bg-surface p-3 text-left text-sm shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  )
}

export function TaskReference({ task }: { task: ProjectedTask }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Link to={taskRoute.to} params={{ id: task.id }} className="text-sky-ink underline">
        {task.id}
      </Link>
      <ReferencePopover label={`task ${task.id}`}>
        <span className="block font-medium text-fg">{task.title || '(no task title)'}</span>
        <span className="mt-1 block text-xs text-fg-muted">State: {task.state}</span>
        <Link
          to={taskRoute.to}
          params={{ id: task.id }}
          className="mt-2 inline-block text-sm text-sky-ink hover:underline"
        >
          Open task
        </Link>
      </ReferencePopover>
    </span>
  )
}

function CommitReference({ hash, repo }: { hash: string; repo: string | null }) {
  const [subject, setSubject] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    if (repo === null || loading || subject !== null) return
    setLoading(true)
    setError(null)
    fetch(
      `${apiBase}/api/repos/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(hash)}`,
    )
      .then(async (response) => {
        const body: unknown = await response.json()
        if (!response.ok) {
          const message =
            body !== null && typeof body === 'object' && 'error' in body
              ? String(body.error)
              : `HTTP ${response.status}`
          throw new Error(message)
        }
        if (body === null || typeof body !== 'object' || !('title' in body)) {
          throw new Error('Invalid commit response')
        }
        setSubject(String(body.title) || '(no commit title)')
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'could not reach the amagi server')
      })
      .finally(() => setLoading(false))
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Link to={gitCommitRoute.to} params={{ hash }} className="text-sky-ink underline">
        {hash}
      </Link>
      <ReferencePopover label={`commit ${hash}`} onOpen={load}>
        <code className="block break-all text-xs text-fg-muted">{hash}</code>
        {loading ? (
          <span className="mt-1 block text-fg-muted">Loading commit…</span>
        ) : error !== null ? (
          <span className="mt-1 block text-red-ink">{error}</span>
        ) : (
          <span className="mt-1 block font-medium text-fg">
            {subject ?? '(commit subject unavailable)'}
          </span>
        )}
        <Link
          to={gitCommitRoute.to}
          params={{ hash }}
          className="mt-2 inline-block text-sm text-sky-ink hover:underline"
        >
          Open commit
        </Link>
      </ReferencePopover>
    </span>
  )
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
