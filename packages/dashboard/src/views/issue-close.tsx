import { useState } from 'react'
import { apiBase } from '../api.ts'
import type { Issue } from './issue-model.ts'

/** Preset close reasons offered for an issue; '__other' falls back to free text. */
const CLOSE_REASONS = [
  'completed',
  'superseded / duplicate',
  'abandoned',
  'merged into another epic',
  'out of scope',
  '__other',
]

type IssueCloseAction = 'manual' | 'done' | 'close'

export function IssueCloseButton({
  repo,
  issue,
  onClosed,
  action = 'close',
}: {
  repo: string
  issue: Pick<Issue, 'id' | 'title' | 'dependents'>
  onClosed: () => void
  action?: IssueCloseAction
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>(CLOSE_REASONS[0] ?? 'completed')
  const [custom, setCustom] = useState('')

  const close = async (finalReason: string) => {
    if (finalReason === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/issues/${issue.id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: finalReason }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
      else {
        onClosed()
        setOpen(false)
      }
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
  const label = 'mb-1 block text-sm text-fg-muted'
  const waiting = (issue.dependents ?? []).filter((dependent) => dependent.status !== 'closed')
  const buttonText =
    action === 'done'
      ? 'Mark done'
      : action === 'close' && waiting.length > 0
        ? `Resolve and rerun ${waiting.map((dependent) => dependent.id).join(', ')}`
        : 'Close'
  const heading = action === 'done' ? `Mark ${issue.id} done` : `Close ${issue.id}`
  const reasonId = `issue-${action}-reason-${issue.id}`
  const customId = `issue-${action}-custom-${issue.id}`

  return (
    <div className={action === 'manual' ? 'ml-auto' : undefined}>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-emerald-500 disabled:opacity-50"
      >
        {buttonText}
      </button>
      {error !== null && !open && <p className="mt-1 text-sm text-red-ink">{error}</p>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void close(reason === '__other' ? custom.trim() : reason)
            }}
            className="w-full max-w-sm rounded-lg border border-line-strong bg-surface p-4"
          >
            <h2 className="mb-3 text-lg font-semibold">{heading}</h2>
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">{issue.title}</p>
              <div>
                <label className={label} htmlFor={reasonId}>
                  Reason for closing
                </label>
                <select
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={input}
                >
                  {CLOSE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r === '__other' ? 'Other...' : r}
                    </option>
                  ))}
                </select>
              </div>
              {reason === '__other' && (
                <div>
                  <label className={label} htmlFor={customId}>
                    Custom reason
                  </label>
                  <input
                    id={customId}
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                    className={input}
                  />
                </div>
              )}
              {error !== null && <p className="text-sm text-red-ink">{error}</p>}
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
                {busy ? 'Closing…' : buttonText}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
