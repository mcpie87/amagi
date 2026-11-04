import { PROPOSED_LABEL } from '@amagi/core/beads-labels'
import { errMsg } from '@amagi/core/errors'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { Markdown } from '../markdown.tsx'
import type { RepoInfo } from '../store.tsx'
import type { Issue } from './issue-model.ts'

type Proposal = Issue & { repo: RepoInfo }

export function ProposalsInbox({
  repos,
  refresh,
  onChanged,
  selectRepo,
}: {
  repos: RepoInfo[]
  refresh: number
  onChanged: () => void
  selectRepo: (key: string) => void
}) {
  const navigate = useNavigate()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refresh
    let active = true
    setError(null)
    // A repo whose config does not load already reports it in its readiness checks.
    const loadable = repos.filter((repo) =>
      repo.ready.every((check) => check.name !== 'config' || check.ok),
    )
    void Promise.allSettled(
      loadable.map(async (repo) => {
        const response = await fetch(`${apiBase}/api/repos/${repo.key}/issues`)
        if (!response.ok)
          throw new Error(
            `${repo.name}: ${(await response.json()).error ?? `HTTP ${response.status}`}`,
          )
        const issues = (await response.json()) as Issue[]
        return issues
          .filter((issue) => issue.status !== 'closed' && issue.labels.includes(PROPOSED_LABEL))
          .map((issue) => ({ ...issue, repo }))
      }),
    ).then((results) => {
      if (!active) return
      setProposals(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])))
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [errMsg(result.reason)] : [],
      )
      setError(failures.length > 0 ? failures.join('; ') : null)
    })
    return () => {
      active = false
    }
  }, [repos, refresh])

  const act = async (proposal: Proposal, operation: 'accept' | 'dismiss', payload: unknown) => {
    const response = await fetch(
      `${apiBase}/api/repos/${proposal.repo.key}/issues/${proposal.id}${operation === 'dismiss' ? '/close' : ''}`,
      {
        method: operation === 'dismiss' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    )
    if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`)
    onChanged()
  }

  if (proposals.length === 0 && error === null) return null
  return (
    <div className="mb-8 rounded-lg border border-amber-edge bg-amber-soft/30 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-ink">
        Proposed follow-ups ({proposals.length})
      </h2>
      <p className="mb-3 mt-1 text-sm text-fg-faint">
        Review out-of-scope findings before they enter the ready queue.
      </p>
      {error !== null && (
        <p className="mb-3 text-sm text-red-ink">Could not load proposals: {error}</p>
      )}
      {proposals.length === 0 ? (
        <p className="text-sm text-fg-faint">No pending proposals.</p>
      ) : (
        <ul className="space-y-3">
          {proposals.map((proposal) => (
            <ProposalCard
              key={`${proposal.repo.key}/${proposal.id}`}
              proposal={proposal}
              onAct={act}
              onSourceTask={() => {
                const sourceTask = proposal.description.match(/^Source task: (.+)$/m)?.[1]
                if (sourceTask === undefined) return
                selectRepo(proposal.repo.key)
                void navigate({ to: '/tasks', search: { issue: sourceTask } })
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ProposalCard({
  proposal,
  onAct,
  onSourceTask,
}: {
  proposal: Proposal
  onAct: (proposal: Proposal, operation: 'accept' | 'dismiss', payload: unknown) => Promise<void>
  onSourceTask: () => void
}) {
  const [priority, setPriority] = useState(
    proposal.priority === null ? '' : String(proposal.priority),
  )
  const [reason, setReason] = useState('')
  const [dismissing, setDismissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sourcePr = proposal.description.match(/^Source PR: (https?:\/\/\S+)/m)?.[1]
  const sourceTask = proposal.description.match(/^Source task: (.+)$/m)?.[1]

  const submit = async (operation: 'accept' | 'dismiss') => {
    setBusy(true)
    setError(null)
    try {
      if (operation === 'accept') {
        await onAct(proposal, operation, {
          labels: proposal.labels.filter((label) => label !== PROPOSED_LABEL),
          ...(priority === '' ? {} : { priority: Number(priority) }),
        })
      } else {
        await onAct(proposal, operation, { reason })
      }
    } catch (err) {
      setError(errMsg(err))
      setBusy(false)
    }
  }

  return (
    <li className="rounded-md border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-fg-strong">{proposal.title}</h3>
          <p className="mt-1 text-xs text-fg-faint">
            {proposal.repo.name} · {proposal.id}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          Priority
          <select
            aria-label={`Priority for ${proposal.title}`}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="rounded border border-line-strong bg-surface px-2 py-1 text-fg"
          >
            <option value="">Suggested: none</option>
            {[0, 1, 2, 3, 4].map((value) => (
              <option key={value} value={value}>
                P{value}
                {proposal.priority === value ? ' (suggested)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Evidence and context
        </h4>
        <Markdown text={proposal.description || 'No evidence was included.'} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {sourceTask !== undefined && (
          <button type="button" onClick={onSourceTask} className="text-sky-ink hover:underline">
            Source task {sourceTask}
          </button>
        )}
        {sourcePr !== undefined && (
          <a
            href={sourcePr}
            target="_blank"
            rel="noreferrer"
            className="text-sky-ink hover:underline"
          >
            Source PR
          </a>
        )}
      </div>
      {dismissing && (
        <label className="mt-3 block text-sm text-fg-muted">
          Dismissal reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            rows={2}
            className="mt-1 block w-full rounded border border-line-strong bg-surface px-3 py-2 text-fg"
          />
        </label>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit('accept')}
          className="rounded bg-emerald-ink px-3 py-1 text-sm font-medium text-on-solid disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Accept'}
        </button>
        {dismissing ? (
          <>
            <button
              type="button"
              disabled={busy || reason.trim() === ''}
              onClick={() => void submit('dismiss')}
              className="rounded bg-red-ink px-3 py-1 text-sm font-medium text-on-solid disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Confirm dismissal'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDismissing(false)}
              className="rounded border border-line-strong px-3 py-1 text-sm hover:bg-raised"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setDismissing(true)}
            className="rounded border border-line-strong px-3 py-1 text-sm hover:bg-raised disabled:opacity-50"
          >
            Dismiss
          </button>
        )}
      </div>
    </li>
  )
}
