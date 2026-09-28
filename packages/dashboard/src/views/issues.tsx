import { PROPOSED_LABEL } from '@amagi/core/drivers/tracker/beads'
import { errMsg } from '@amagi/core/errors'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { Markdown } from '../markdown.tsx'
import { issuesRoute } from '../routes.tsx'
import { type RepoInfo, useDashboard } from '../store.tsx'
import { IssueBoard } from './issue-board.tsx'
import { EpicDetailView, IssueDetailView } from './issue-details.tsx'
import type { Issue } from './issue-model.ts'

/** One epic from /api/repos/:repo/epics/close-eligible (bd epic close-eligible --dry-run). */
type EligibleEpic = {
  id: string
  title: string
  status: string
  totalChildren: number
  closedChildren: number
}

/** Preset close reasons offered for an epic; '__other' falls back to free text. */
const EPIC_CLOSE_REASONS = [
  'completed',
  'superseded / duplicate',
  'abandoned',
  'merged into another epic',
  'out of scope',
  '__other',
]

function IssueFormModal({
  repo,
  mode,
  initial,
  onClose,
  onSaved,
}: {
  repo: string
  mode: 'create' | 'edit'
  initial: Issue | null
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [acceptance, setAcceptance] = useState(initial?.acceptanceCriteria ?? '')
  const [priority, setPriority] = useState(
    initial?.priority === undefined || initial?.priority === null ? '' : String(initial.priority),
  )
  const [labels, setLabels] = useState((initial?.labels ?? []).join(', '))
  const [dependencies, setDependencies] = useState(
    (initial?.dependencies ?? []).map((d) => d.id).join(', '),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || title.trim() === '') return
    setBusy(true)
    setError(null)
    const payload = {
      title: title.trim(),
      description,
      acceptanceCriteria: acceptance.trim() === '' ? null : acceptance,
      priority: priority === '' ? null : Number(priority),
      labels: labels
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
      dependencies: dependencies
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    }
    try {
      const url =
        mode === 'create'
          ? `${apiBase}/api/repos/${repo}/issues`
          : `${apiBase}/api/repos/${repo}/issues/${initial?.id}`
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      onSaved()
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
  const label = 'mb-1 block text-sm text-fg-muted'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg border border-line-strong bg-surface p-4"
      >
        <h2 className="mb-3 text-lg font-semibold">
          {mode === 'create' ? 'New task' : `Edit ${initial?.id ?? ''}`}
        </h2>
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="issue-title">
              Title
            </label>
            <input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={input}
            />
          </div>
          <div>
            <label className={label} htmlFor="issue-description">
              Description
            </label>
            <textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={input}
            />
          </div>
          <div>
            <label className={label} htmlFor="issue-acceptance">
              Acceptance criteria
            </label>
            <textarea
              id="issue-acceptance"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={3}
              className={input}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="issue-priority">
                Priority
              </label>
              <select
                id="issue-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={input}
              >
                <option value="">None</option>
                <option value="0">P0</option>
                <option value="1">P1</option>
                <option value="2">P2</option>
                <option value="3">P3</option>
                <option value="4">P4</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="issue-labels">
                Labels (comma separated)
              </label>
              <input
                id="issue-labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                className={input}
              />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="issue-dependencies">
              Blocked by issue ids (comma separated)
            </label>
            <input
              id="issue-dependencies"
              value={dependencies}
              onChange={(e) => setDependencies(e.target.value)}
              className={input}
              placeholder="am-abc, am-123"
            />
            <p className={label}>The task waits on these issues before it can run.</p>
          </div>
        </div>
        {error !== null && <p className="mt-3 text-sm text-red-ink">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || title.trim() === ''}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create task' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}

type EpicCloseAction = 'manual' | 'done'

function EpicCloseButton({
  repo,
  epic,
  onClosed,
  action,
}: {
  repo: string
  epic: Pick<EligibleEpic, 'id' | 'title'>
  onClosed: () => void
  action: EpicCloseAction
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>(EPIC_CLOSE_REASONS[0] ?? 'completed')
  const [custom, setCustom] = useState('')

  const close = async (finalReason: string) => {
    if (finalReason === '') return
    setBusy(true)
    setError(null)
    try {
      const path =
        action === 'manual'
          ? `/api/repos/${repo}/epics/close-eligible`
          : `/api/repos/${repo}/issues/${epic.id}/close`
      const res = await fetch(`${apiBase}${path}`, {
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
  const buttonText = action === 'manual' ? 'Close' : 'Mark done'
  const heading = action === 'manual' ? `Close ${epic.id}` : `Mark ${epic.id} done`
  const reasonId = `epic-${action}-reason-${epic.id}`
  const customId = `epic-${action}-custom-${epic.id}`

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
              <p className="text-sm text-fg-muted">{epic.title}</p>
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
                  {EPIC_CLOSE_REASONS.map((r) => (
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

/** Manual fallback for a finished epic when automatic closure is disabled. */
function CloseEpicButton({
  repo,
  epic,
  onClosed,
}: {
  repo: string
  epic: EligibleEpic
  onClosed: () => void
}) {
  return <EpicCloseButton repo={repo} epic={epic} onClosed={onClosed} action="manual" />
}

function MarkEpicDoneButton({
  repo,
  epic,
  onClosed,
}: {
  repo: string
  epic: Pick<EligibleEpic, 'id' | 'title'>
  onClosed: () => void
}) {
  return <EpicCloseButton repo={repo} epic={epic} onClosed={onClosed} action="done" />
}

type Proposal = Issue & { repo: RepoInfo }

function ProposalsInbox({
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
    let active = true
    setError(null)
    Promise.all(
      repos.map(async (repo) => {
        const response = await fetch(`${apiBase}/api/repos/${repo.key}/issues`)
        if (!response.ok)
          throw new Error((await response.json()).error ?? `HTTP ${response.status}`)
        const issues = (await response.json()) as Issue[]
        return issues
          .filter((issue) => issue.status !== 'closed' && issue.labels.includes(PROPOSED_LABEL))
          .map((issue) => ({ ...issue, repo }))
      }),
    )
      .then((lists) => {
        if (active) setProposals(lists.flat())
      })
      .catch((err: unknown) => {
        if (active) setError(errMsg(err))
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
                void navigate({ to: '/issues', search: { issue: sourceTask } })
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
          className="rounded bg-emerald-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Accept'}
        </button>
        {dismissing ? (
          <>
            <button
              type="button"
              disabled={busy || reason.trim() === ''}
              onClick={() => void submit('dismiss')}
              className="rounded bg-red-700 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
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

export function IssuesView() {
  const { selected, repos, selectRepo } = useDashboard()
  const [issues, setIssues] = useState<Issue[]>([])
  const [eligibleEpics, setEligibleEpics] = useState<EligibleEpic[]>([])
  const { issue: selectedId, epic: selectedEpicId } = useSearch({ from: issuesRoute.id })
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; issue: Issue } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const repoRef = useRef(selected)
  useEffect(() => {
    if (selected === null) return
    void refresh
    if (repoRef.current !== selected) {
      repoRef.current = selected
      setIssues([])
      void navigate({ to: '/issues', search: {}, replace: true })
    }
    setError(null)
    fetch(`${apiBase}/api/repos/${selected}/issues`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then(setIssues)
      .catch((err: unknown) => setError(errMsg(err)))
  }, [selected, refresh, navigate])

  useEffect(() => {
    if (selected === null) return
    void refresh
    fetch(`${apiBase}/api/repos/${selected}/epics/close-eligible`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<EligibleEpic[]>
      })
      .then(setEligibleEpics)
      // An unavailable or unreachable tracker means no epic surface, not a
      // broken tasks view: the issue fetch above reports connectivity.
      .catch(() => setEligibleEpics([]))
  }, [selected, refresh])

  const saved = () => {
    setForm(null)
    setRefresh((value) => value + 1)
  }

  const openIssue = (id: string | null) =>
    void navigate({
      to: '/issues',
      replace: false,
      search: {
        ...(id === null ? {} : { issue: id }),
        ...(selectedEpicId === undefined ? {} : { epic: selectedEpicId }),
      },
    })
  const selectedEpic =
    selectedEpicId === undefined
      ? null
      : (eligibleEpics.find((epic) => epic.id === selectedEpicId) ?? null)

  const backToList = (
    <button
      type="button"
      onClick={() => openIssue(null)}
      className="text-sm text-sky-ink hover:underline"
    >
      &larr; {selectedEpicId === undefined ? 'tasks' : 'epic'}
    </button>
  )

  if (selectedId !== undefined) {
    return (
      <>
        <IssueDetailView
          repo={selected}
          id={selectedId}
          refresh={refresh}
          back={backToList}
          onEdit={(issue) => setForm({ mode: 'edit', issue })}
          actions={
            selected !== null &&
            selectedEpic !== null &&
            eligibleEpics.some((epic) => epic.id === selectedId) ? (
              <MarkEpicDoneButton repo={selected} epic={selectedEpic} onClosed={saved} />
            ) : null
          }
        />
        {selected !== null && form !== null && (
          <IssueFormModal
            repo={selected}
            mode={form.mode}
            initial={form.mode === 'edit' ? form.issue : null}
            onClose={() => setForm(null)}
            onSaved={saved}
          />
        )}
      </>
    )
  }
  if (selectedEpicId !== undefined && selectedId === undefined) {
    const epicBack = (
      <button
        type="button"
        onClick={() => void navigate({ to: '/issues', search: {}, replace: true })}
        className="text-sm text-sky-ink hover:underline"
      >
        &larr; tasks
      </button>
    )
    return (
      <EpicDetailView
        repo={selected}
        id={selectedEpicId}
        refresh={refresh}
        epic={selectedEpic}
        back={epicBack}
        actions={
          selected !== null &&
          selectedEpic !== null &&
          eligibleEpics.some((epic) => epic.id === selectedEpic.id) ? (
            <MarkEpicDoneButton repo={selected} epic={selectedEpic} onClosed={saved} />
          ) : null
        }
        onOpenIssue={openIssue}
      />
    )
  }
  return (
    <section>
      <ProposalsInbox
        repos={repos ?? []}
        refresh={refresh}
        onChanged={saved}
        selectRepo={selectRepo}
      />
      {selected !== null && eligibleEpics.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-ink">
            Eligible epics ({eligibleEpics.length})
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {eligibleEpics.map((epic) => (
              <li key={epic.id} className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: '/issues',
                      search: { epic: epic.id },
                      replace: false,
                    })
                  }
                  className="min-w-0 flex-1 text-left hover:text-sky-ink"
                >
                  <span className="block truncate font-medium">{epic.title}</span>
                  <span className="block truncate text-xs text-fg-faint">
                    {epic.id} · {epic.closedChildren}/{epic.totalChildren} children done
                  </span>
                </button>
                <CloseEpicButton repo={selected} epic={epic} onClosed={saved} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <IssueBoard
        issues={issues}
        error={error}
        hasRepo={selected !== null}
        onOpenIssue={(id) => openIssue(id)}
        onCreate={() => setForm({ mode: 'create' })}
      />
      {selected !== null && form !== null && (
        <IssueFormModal
          repo={selected}
          mode={form.mode}
          initial={form.mode === 'edit' ? form.issue : null}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
    </section>
  )
}
