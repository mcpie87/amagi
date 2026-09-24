import { canReset, isTerminal, type TaskState } from '@amagi/core/events'
import type { ProjectedQuestion } from '@amagi/core/view'
import { type FormEvent, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useDashboard, useRunner } from '../store.tsx'
import { Icon } from '../ui.tsx'

/** Preset reasons offered when marking a task done; '__other' falls back to free text. */
const TASK_DONE_REASONS = [
  'completed',
  'already done elsewhere',
  'duplicate / superseded',
  'out of scope',
  '__other',
]

export function AnswerBox({
  repo,
  taskId,
  question,
}: {
  repo: string
  taskId: string
  question: ProjectedQuestion
}) {
  const [token, setToken] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}`)
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
  }, [repo, taskId])

  const send = async (answer: string) => {
    if (token === null || answer.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${apiBase}/api/repos/${repo}/tasks/${taskId}/questions/${question.id}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
          body: JSON.stringify({ answer, via: 'web' }),
        },
      )
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
      else setSubmitted(true)
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
    return <p className="mt-2 text-sm text-fg-faint">answer box unavailable</p>
  }

  if (submitted) {
    return <p className="mt-2 text-sm text-emerald-ink">answered</p>
  }

  if (submitted) {
    return <p className="mt-2 text-sm text-emerald-400">answered</p>
  }

  return (
    <div className="mt-2">
      {question.options.length > 0 && (
        <div className="answer-options flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send(option)}
              className="rounded border border-amber-edge bg-amber-soft px-3 py-1 text-sm hover:bg-amber-soft-hover disabled:opacity-50"
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
          className="flex-1 rounded border border-line-strong bg-sunken px-3 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-on-solid disabled:opacity-50"
        >
          Answer
        </button>
      </form>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

export function ReclaimButton({
  repo,
  taskId,
  state,
  worktree,
}: {
  repo: string
  taskId: string
  state: TaskState
  worktree: string | null
}) {
  const { status } = useRunner()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  // A retrying task is still owned by its runner, which will retry on its own;
  // reclaiming it here would hand the tracker claim to a second worker.
  // A queued task already has no tracker claim to release.
  if (worktree === null || isTerminal(state) || state === 'retrying' || state === 'queued') {
    return null
  }

  const reclaim = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/reclaim`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setResult({ kind: 'error', text: body?.error ?? `HTTP ${res.status}` })
        return
      }
      const availability =
        status === null
          ? 'the runner is offline, so the task waits for a runner'
          : status.available
            ? 'the runner has a free slot'
            : `the runner is busy (${status.running.length}/${status.capacity})`
      setResult({
        kind: 'ok',
        text: `queued; ${availability}. The task waits for a slot.`,
      })
    } catch {
      setResult({ kind: 'error', text: 'could not reach the amagi server' })
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
        title="releases the tracker claim back to the queue; the task waits for a free runner slot"
        className="rounded border border-red-edge bg-red-soft px-3 py-1 text-sm text-red-ink hover:bg-red-soft-hover disabled:opacity-50"
      >
        Reclaim
      </button>
      {result !== null && (
        <p className={`mt-1 text-sm ${result.kind === 'ok' ? 'text-emerald-ink' : 'text-red-ink'}`}>
          {result.text}
        </p>
      )}
    </div>
  )
}

/** A task the operator can still retire: in flight, parked, or stopped. */
function closable(state: TaskState): boolean {
  return !isTerminal(state) || state === 'needs_human' || state === 'no_pr' || state === 'cancelled'
}

function CloseButton({
  repo,
  taskId,
  state,
  target,
}: {
  repo: string
  taskId: string
  state: TaskState
  target: 'abandoned' | 'done'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>(TASK_DONE_REASONS[0] ?? 'completed')
  const [custom, setCustom] = useState('')
  const { resyncStream } = useDashboard()
  if (target === 'done' && state !== 'needs_human' && state !== 'no_pr') return null

  const close = async (finalReason: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: finalReason, to: target }),
      })
      // The state change lands in the store server-side; if the event stream
      // is stale the completed task keeps its old state until a page refresh,
      // so force a resync instead of waiting for the operator to reload.
      resyncStream()
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
      else setOpen(false)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const onMarkDone = () => {
    setOpen(true)
  }

  const submit = () => {
    const finalReason = reason === '__other' ? custom.trim() : reason
    if (finalReason === '') return
    void close(finalReason)
  }

  const input =
    'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
  const label = 'mb-1 block text-sm text-fg-muted'

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (target === 'done') onMarkDone()
          else {
            const reason = window.prompt(`Reason for closing ${taskId}`)
            if (reason === null || reason.trim() === '') return
            void close(reason.trim())
          }
        }}
        title={
          target === 'done'
            ? 'marks the task done when the work already existed elsewhere'
            : state === 'pr_flagged'
              ? 'closes the pointless pull request on the forge and retires the task'
              : 'closes the task as abandoned'
        }
        className={
          target === 'done'
            ? 'rounded border border-emerald-edge bg-emerald-soft px-3 py-1 text-sm text-emerald-ink hover:bg-emerald-soft-hover disabled:opacity-50'
            : state === 'pr_flagged'
              ? 'rounded border border-red-edge bg-red-soft px-3 py-1 text-sm text-red-ink hover:bg-red-soft-hover disabled:opacity-50'
              : 'rounded border border-line-strong bg-raised px-3 py-1 text-sm text-fg hover:bg-raised-strong disabled:opacity-50'
        }
      >
        {target === 'done' ? 'Mark done' : state === 'pr_flagged' ? 'Close PR' : 'Close'}
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
      {target === 'done' && open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            className="w-full max-w-sm rounded-lg border border-line-strong bg-surface p-4"
          >
            <h2 className="mb-3 text-lg font-semibold">Mark done {taskId}</h2>
            <div className="space-y-3">
              <div>
                <label className={label} htmlFor="task-done-reason">
                  Reason for marking this task done
                </label>
                <select
                  id="task-done-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={input}
                >
                  {TASK_DONE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r === '__other' ? 'Other...' : r}
                    </option>
                  ))}
                </select>
              </div>
              {reason === '__other' && (
                <div>
                  <label className={label} htmlFor="task-done-custom">
                    Custom reason
                  </label>
                  <input
                    id="task-done-custom"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    className={input}
                  />
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || (reason === '__other' && custom.trim() === '')}
                className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-emerald-500 disabled:opacity-50"
              >
                Mark done
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

/** The two operator retire actions: close as abandoned, or mark done when the work already existed. */
export function CloseButtons({
  repo,
  taskId,
  state,
}: {
  repo: string
  taskId: string
  state: TaskState
}) {
  // A pr_open task's PR is live: closing would abandon the task and leave the
  // pull request dangling open on the forge, so only a flagged (pointless) PR
  // gets a close action.
  if (state === 'pr_open') return null
  if (!closable(state)) return null
  // Only a parked no_pr/needs_human task can be marked done; the server rejects
  // it otherwise, so don't offer a button that always errors.
  const canMarkDone = state === 'needs_human' || state === 'no_pr'
  return (
    <div className="ml-auto flex gap-2">
      {canMarkDone && <CloseButton repo={repo} taskId={taskId} state={state} target="done" />}
      <CloseButton repo={repo} taskId={taskId} state={state} target="abandoned" />
    </div>
  )
}

/**
 * The error-task retry path for a task parked at needs_human: file the recorded
 * error as its own tracker task, block this task on it, and release the claim
 * so it reruns once the error task is resolved. Unlike Reclaim this does
 * not resume the same work blindly; it hands the root cause to a human first.
 */
export function FileAsErrorButton({
  repo,
  taskId,
  state,
  statusReason,
}: {
  repo: string
  taskId: string
  state: TaskState
  statusReason: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  if (state !== 'needs_human' || statusReason === null) return null

  const file = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/filed-as-error`, {
        method: 'POST',
      })
      const body = (await res.json().catch(() => null)) as {
        error?: string
        errorTask?: { id: string }
      } | null
      if (!res.ok) {
        setResult({ kind: 'error', text: body?.error ?? `HTTP ${res.status}` })
        return
      }
      setResult({
        kind: 'ok',
        text: `filed as ${body?.errorTask?.id ?? 'error task'}; reruns once that task is resolved`,
      })
    } catch {
      setResult({ kind: 'error', text: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void file()}
        title="files this task's error as its own task, blocks this task on it, and reruns it once the error task is resolved"
        className="rounded border border-amber-edge bg-amber-soft px-3 py-1 text-sm text-amber-ink hover:bg-amber-soft-hover disabled:opacity-50"
      >
        File as error task
      </button>
      {result !== null && (
        <p className={`mt-1 text-sm ${result.kind === 'ok' ? 'text-emerald-ink' : 'text-red-ink'}`}>
          {result.text}
        </p>
      )}
    </div>
  )
}

/**
 * Start a parked task over as a fresh attempt: the server drops the worktree,
 * branch and session, so nothing of the previous run is resumed. The earlier
 * attempt stays browsable from the attempt switcher.
 */
export function ResetButton({
  repo,
  taskId,
  state,
  worktree,
}: {
  repo: string
  taskId: string
  state: TaskState
  worktree: string | null
}) {
  const { start } = useRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!canReset(state, worktree !== null)) return null

  const reset = async () => {
    if (
      !window.confirm(
        `Reset ${taskId}? Its worktree and branch are deleted and it reruns from scratch.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/reset`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      const run = await start(taskId)
      if (!run.ok) setError(run.error ?? 'run failed to start')
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="reset-run">
      <button
        type="button"
        disabled={busy}
        onClick={() => void reset()}
        title="deletes the worktree, branch and agent session, then reruns the task from scratch as a new attempt"
        className="rounded border border-line-strong bg-raised px-3 py-1 text-sm text-fg hover:bg-raised-strong disabled:opacity-50"
      >
        <Icon name="refresh" size={15} />
        {busy ? 'Resetting...' : 'Reset'}
      </button>
      {error !== null && (
        <p className="reset-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Switch the task detail between the current attempt and earlier, reset ones. */
export function AttemptSwitcher({
  current,
  viewing,
  onSelect,
}: {
  current: number
  viewing: number
  onSelect: (attempt: number | null) => void
}) {
  if (current < 2) return null
  return (
    <div className="detail-tabs mt-3 flex gap-1 border-b border-line">
      {Array.from({ length: current }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onSelect(n === current ? null : n)}
          className={`rounded-t px-3 py-1.5 text-sm ${
            viewing === n
              ? 'border-b-2 border-sky-500 text-fg-strong'
              : 'text-fg-muted hover:text-fg'
          }`}
        >
          Attempt #{n}
          {n === current ? ' (current)' : ''}
        </button>
      ))}
    </div>
  )
}

/**
 * Skip a deferred automatic retry's backoff and run it now, only meaningful
 * while the task sits in retrying (the runner owns it and is sleeping).
 */
export function RetryNowButton({
  repo,
  taskId,
  state,
}: {
  repo: string
  taskId: string
  state: TaskState
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state !== 'retrying') return null

  const retryNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/retry`, {
        method: 'POST',
      })
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
        onClick={() => void retryNow()}
        className="rounded border border-orange-edge bg-orange-soft px-3 py-1 text-sm text-orange-ink hover:bg-orange-soft-hover disabled:opacity-50"
      >
        Retry now
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

/** Re-runs the pr reconcile for one parked PR instead of waiting for the sweep. */
export function RecheckPrButton({
  repo,
  taskId,
  state,
}: {
  repo: string
  taskId: string
  state: TaskState
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state !== 'pr_open' && state !== 'pr_flagged') return null

  const recheck = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/recheck`, {
        method: 'POST',
      })
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
        onClick={() => void recheck()}
        className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Check PR status now'}
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

export function StopButton({ taskId }: { taskId: string }) {
  const { status, stop } = useRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (status === null || !status.running.includes(taskId)) return null

  const doStop = async () => {
    setBusy(true)
    setError(null)
    const res = await stop(taskId)
    setBusy(false)
    if (!res.ok) setError(res.error ?? 'stop failed')
  }

  return (
    <div className="ml-auto">
      <button type="button" className="stop-button" disabled={busy} onClick={() => void doStop()}>
        Stop
      </button>
      {error !== null && <p className="run-button-error">{error}</p>}
    </div>
  )
}
