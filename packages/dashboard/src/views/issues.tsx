import { HUMAN_ONLY_LABEL } from '@amagi/core/drivers/tracker/beads'
import { errMsg } from '@amagi/core/errors'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { DetailRow, PILL } from '../badges.tsx'
import { Markdown } from '../markdown.tsx'
import { issuesRoute } from '../routes.tsx'
import { useDashboard } from '../store.tsx'

type Dependency = {
  id: string
  title: string
  /** Tracker status of the blocker: open/in_progress/blocked/closed. */
  status: string
  /** Human-only blockers carry the `human` label and need an operator, not an agent. */
  labels: string[]
}

export type Issue = {
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
  dependencies: Dependency[]
  /** Issues this one blocks; only the single-issue detail endpoint reports them. */
  dependents?: Dependency[]
}

/** One issue with its blockers and dependents, from the tracker's detail view. */
export async function fetchIssue(repo: string, id: string): Promise<Issue> {
  const res = await fetch(`${apiBase}/api/repos/${repo}/issues/${id}`)
  if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<Issue>
}

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

const ISSUE_STATES: Issue['status'][] = ['open', 'in_progress', 'blocked', 'closed']

const columnHeader: Record<Issue['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
}

const columnDot: Record<Issue['status'], string> = {
  open: 'bg-fg-faint',
  in_progress: 'bg-blue-500',
  blocked: 'bg-red-500',
  closed: 'bg-emerald-500',
}

function IssueBadge({ issue }: { issue: Issue }) {
  const tone =
    issue.status === 'closed'
      ? 'bg-emerald-soft text-emerald-ink ring-emerald-edge'
      : issue.status === 'blocked'
        ? 'bg-red-soft text-red-ink ring-red-edge'
        : issue.status === 'in_progress'
          ? 'bg-blue-soft text-blue-ink ring-blue-edge'
          : 'bg-neutral-soft text-fg ring-neutral-edge'
  return <span className={`${PILL} ${tone}`}>{issue.status}</span>
}

type IssuesViewMode = 'kanban' | 'list'

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

/** The operator's call to close a finished epic; the worker never decides this. */
function CloseEpicButton({
  repo,
  epic,
  onClosed,
}: {
  repo: string
  epic: EligibleEpic
  onClosed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState<string>(EPIC_CLOSE_REASONS[0] ?? 'completed')
  const [custom, setCustom] = useState('')

  const close = async (finalReason: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/epics/close-eligible`, {
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

  const submit = () => {
    const finalReason = reason === '__other' ? custom.trim() : reason
    if (finalReason === '') return
    void close(finalReason)
  }

  const input =
    'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
  const label = 'mb-1 block text-sm text-fg-muted'

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-emerald-500 disabled:opacity-50"
      >
        Close
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
            className="w-full max-w-sm rounded-lg border border-line-strong bg-surface p-4"
          >
            <h2 className="mb-3 text-lg font-semibold">Close {epic.id}</h2>
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">{epic.title}</p>
              <div>
                <label className={label} htmlFor="epic-close-reason">
                  Reason for closing
                </label>
                <select
                  id="epic-close-reason"
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
                  <label className={label} htmlFor="epic-close-custom">
                    Custom reason
                  </label>
                  <input
                    id="epic-close-custom"
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
                Close
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export function IssuesView() {
  const { selected } = useDashboard()
  const [issues, setIssues] = useState<Issue[]>([])
  const [eligibleEpics, setEligibleEpics] = useState<EligibleEpic[]>([])
  const { issue: selectedId } = useSearch({ from: issuesRoute.id })
  const navigate = useNavigate()
  const [issueDetail, setIssueDetail] = useState<Issue | null>(null)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [selectedEpic, setSelectedEpic] = useState<EligibleEpic | null>(null)
  const [epicChildren, setEpicChildren] = useState<Issue[]>([])
  const [epicChildrenLoading, setEpicChildrenLoading] = useState(false)
  const [epicChildrenError, setEpicChildrenError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Issue['status'] | 'all'>('all')
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; issue: Issue } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const repoRef = useRef(selected)
  const [view, setView] = useState<IssuesViewMode>(() => {
    try {
      return localStorage.getItem('amagi:issue-view') === 'list' ? 'list' : 'kanban'
    } catch {
      // storage unavailable (private mode, blocked), keep the default
      return 'kanban'
    }
  })

  const setMode = (mode: IssuesViewMode) => {
    setView(mode)
    try {
      localStorage.setItem('amagi:issue-view', mode)
    } catch {
      // storage unavailable, the choice just won't persist
    }
  }

  useEffect(() => {
    if (selected === null) return
    void refresh
    if (repoRef.current !== selected) {
      repoRef.current = selected
      setIssues([])
      setSelectedEpic(null)
      void navigate({ to: '/issues', search: {} })
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
    setIssueError(null)
    if (selected === null || selectedId === undefined) return
    void refresh
    let active = true
    fetchIssue(selected, selectedId)
      .then((issue) => {
        if (active) setIssueDetail(issue)
      })
      .catch((err: unknown) => {
        if (active) setIssueError(errMsg(err))
      })
    return () => {
      active = false
    }
  }, [selected, selectedId, refresh])

  useEffect(() => {
    if (selected === null || selectedEpic === null) return
    void refresh
    let active = true
    setEpicChildren([])
    setEpicChildrenLoading(true)
    setEpicChildrenError(null)
    fetch(`${apiBase}/api/repos/${selected}/issues/${selectedEpic.id}/children`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then((children) => {
        if (active) setEpicChildren(children)
      })
      .catch((err: unknown) => {
        if (active) setEpicChildrenError(errMsg(err))
      })
      .finally(() => {
        if (active) setEpicChildrenLoading(false)
      })
    return () => {
      active = false
    }
  }, [selected, selectedEpic, refresh])

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
    void navigate({ to: '/issues', search: id === null ? {} : { issue: id } })
  // The previous detail stays up while a refresh refetches it, but never
  // stands in for a different issue.
  const selectedIssue = issueDetail?.id === selectedId ? issueDetail : null

  const q = search.trim().toLowerCase()
  const filtered = status === 'all' ? issues : issues.filter((issue) => issue.status === status)
  const searched =
    q === ''
      ? filtered
      : filtered.filter(
          (issue) => issue.title.toLowerCase().includes(q) || issue.id.toLowerCase().includes(q),
        )

  const backToList = (
    <button
      type="button"
      onClick={() => openIssue(null)}
      className="text-sm text-sky-ink hover:underline"
    >
      &larr; {selectedEpic === null ? 'tasks' : 'epic'}
    </button>
  )

  if (selectedId !== undefined && selectedIssue === null) {
    return (
      <section>
        {backToList}
        {issueError !== null ? (
          <p className="mt-4 text-red-ink">{issueError}</p>
        ) : (
          <p className="mt-4 text-fg-faint">Loading {selectedId}...</p>
        )}
      </section>
    )
  }

  if (selectedIssue !== null) {
    return (
      <section>
        {backToList}
        <div className="mt-3 flex items-center gap-3">
          <h1 className="text-xl font-semibold">{selectedIssue.title}</h1>
          <IssueBadge issue={selectedIssue} />
          {selected !== null && (
            <button
              type="button"
              onClick={() => setForm({ mode: 'edit', issue: selectedIssue })}
              className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
            >
              Edit
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-fg-faint">
          {selectedIssue.id}
          {selectedIssue.parent ? ` · child of ${selectedIssue.parent}` : ''}
        </p>
        <dl className="mt-6 rounded-lg border border-line bg-surface px-4 py-3">
          <DetailRow
            label="priority"
            value={selectedIssue.priority === null ? null : `P${selectedIssue.priority}`}
          />
          <DetailRow label="type" value={selectedIssue.type} />
          <DetailRow label="assignee" value={selectedIssue.assignee} />
          <DetailRow label="labels" value={selectedIssue.labels.join(', ') || null} />
        </dl>
        <Blockers issue={selectedIssue} />
        <Unblocks issue={selectedIssue} />
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Description
          </h2>
          <Markdown text={selectedIssue.description || 'No description.'} />
        </div>
        {selectedIssue.acceptanceCriteria !== null && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
              Acceptance criteria
            </h2>
            <p className="whitespace-pre-wrap text-fg">{selectedIssue.acceptanceCriteria}</p>
          </div>
        )}
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
  if (selectedEpic !== null) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setSelectedEpic(null)}
          className="text-sm text-sky-ink hover:underline"
        >
          &larr; tasks
        </button>
        <h1 className="mt-3 text-xl font-semibold">{selectedEpic.title}</h1>
        <p className="mt-1 text-sm text-fg-faint">
          {selectedEpic.id} · {selectedEpic.closedChildren}/{selectedEpic.totalChildren} children
          done
        </p>
        <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Child tasks ({epicChildren.length})
        </h2>
        {epicChildrenError !== null ? (
          <p className="text-sm text-red-ink">{epicChildrenError}</p>
        ) : epicChildrenLoading ? (
          <p className="text-sm text-fg-faint">Loading child tasks...</p>
        ) : epicChildren.length === 0 ? (
          <p className="text-sm text-fg-faint">No child tasks.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {epicChildren.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => openIssue(child.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised"
                >
                  <IssueBadge issue={child} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{child.title}</span>
                    <span className="block truncate text-xs text-fg-faint">
                      {child.id}
                      {child.priority === null ? '' : ` · P${child.priority}`}
                      {child.type === null ? '' : ` · ${child.type}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-sky-600"
          />
          <span className="text-sm text-fg-faint">
            {searched.length} {searched.length === 1 ? 'task' : 'tasks'}
            {status !== 'all' && ` · ${filtered.length} shown`}
          </span>
          <div className="flex rounded-lg border border-line-strong p-0.5">
            <button
              type="button"
              aria-label="Board view"
              onClick={() => setMode('kanban')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'kanban'
                  ? 'bg-raised-strong text-fg-strong'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              Board
            </button>
            <button
              type="button"
              aria-label="List view"
              onClick={() => setMode('list')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'list' ? 'bg-raised-strong text-fg-strong' : 'text-fg-muted hover:text-fg'
              }`}
            >
              List
            </button>
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
            className="rounded border border-line-strong bg-surface px-2 py-1 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="closed">Closed</option>
          </select>
          {selected !== null && (
            <button
              type="button"
              onClick={() => setForm({ mode: 'create' })}
              className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500"
            >
              New task
            </button>
          )}
        </div>
      </div>
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
                  onClick={() => setSelectedEpic(epic)}
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
      {error !== null ? (
        <p className="text-red-ink">{error}</p>
      ) : view === 'kanban' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ISSUE_STATES.map((state) => {
            if (status !== 'all' && status !== state) return null
            const columnIssues = searched.filter((issue) => issue.status === state)
            return (
              <div
                key={state}
                className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
              >
                <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${columnDot[state]}`} />
                    <span className="truncate text-xs font-medium uppercase tracking-wide text-fg">
                      {columnHeader[state]}
                    </span>
                  </span>
                  <span className="rounded bg-raised px-1.5 text-xs tabular-nums text-fg-muted">
                    {columnIssues.length}
                  </span>
                </div>
                <ul className="flex flex-col gap-2 p-2">
                  {columnIssues.map((issue) => (
                    <li key={issue.id}>
                      <button
                        type="button"
                        onClick={() => openIssue(issue.id)}
                        className="issue-card w-full rounded border border-line bg-sunken px-3 py-2 text-left hover:bg-raised"
                      >
                        <span className="block text-xs text-fg-faint">{issue.id}</span>
                        <span className="mt-0.5 block break-words font-medium leading-snug">
                          {issue.title}
                        </span>
                        <span className="mt-1 block text-xs text-fg-faint">
                          {[issue.priority === null ? null : `P${issue.priority}`, issue.type]
                            .filter(Boolean)
                            .join(' · ') || '\u00a0'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {columnIssues.length === 0 && (
                    <li className="px-1 py-2 text-xs text-fg-dim">No tasks.</li>
                  )}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {searched.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => openIssue(issue.id)}
                className="issue-list-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised"
              >
                <IssueBadge issue={issue} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{issue.title}</span>
                  <span className="block truncate text-xs text-fg-faint">
                    {issue.id}
                    {issue.priority === null ? '' : ` · P${issue.priority}`}
                    {issue.type === null ? '' : ` · ${issue.type}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {searched.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-fg-faint">
              No tasks match "{search}".
            </li>
          )}
        </ul>
      )}
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

const DEPENDENCY_TONE = {
  red: {
    heading: 'text-red-ink',
    list: 'border-red-edge bg-red-soft',
    chip: 'bg-red-soft-hover text-red-ink',
  },
  amber: {
    heading: 'text-amber-ink',
    list: 'border-amber-edge bg-amber-soft',
    chip: 'bg-amber-soft-hover text-amber-ink',
  },
  emerald: {
    heading: 'text-emerald-ink',
    list: 'border-emerald-edge bg-emerald-soft',
    chip: 'bg-emerald-soft-hover text-emerald-ink',
  },
} as const

function DependencyList({
  items,
  tone,
}: {
  items: Dependency[]
  tone: keyof typeof DEPENDENCY_TONE
}) {
  return (
    <ul className={`rounded-lg border px-3 py-1 ${DEPENDENCY_TONE[tone].list}`}>
      {items.map((d) => (
        <li key={d.id}>
          <Link
            to="/issues"
            search={{ issue: d.id }}
            className="flex items-center gap-2 py-1 text-sm hover:underline"
          >
            <span className={`rounded px-1.5 py-0.5 text-xs ${DEPENDENCY_TONE[tone].chip}`}>
              {d.status}
            </span>
            <span className="shrink-0 text-fg-faint">{d.id}</span>
            <span className="min-w-0 truncate text-fg">{d.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Why a task cannot run: the open issues it waits on, split by who resolves them. */
export function Blockers({ issue }: { issue: Issue }) {
  const blocking = issue.dependencies.filter((d) => d.status !== 'closed')
  if (blocking.length === 0) return null
  const humanOnly = blocking.filter((d) => d.labels.includes(HUMAN_ONLY_LABEL))
  const tasks = blocking.filter((d) => !d.labels.includes(HUMAN_ONLY_LABEL))

  const group = (title: string, items: Dependency[], tone: 'red' | 'amber') => (
    <div>
      <h3
        className={`mb-1 text-xs font-semibold uppercase tracking-wide ${DEPENDENCY_TONE[tone].heading}`}
      >
        {title} ({items.length})
      </h3>
      <DependencyList items={items} tone={tone} />
    </div>
  )

  return (
    <div className="mt-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-ink">
        Blocked by
      </h2>
      <p className="mb-2 text-sm text-fg-faint">
        This task cannot run until every blocker is closed.
      </p>
      <div className="space-y-3">
        {tasks.length > 0 && group('Tasks', tasks, 'red')}
        {humanOnly.length > 0 && group('Human-only', humanOnly, 'amber')}
      </div>
    </div>
  )
}

/** The open issues waiting on this one: closing it lets them run. */
export function Unblocks({ issue }: { issue: Issue }) {
  const waiting = (issue.dependents ?? []).filter((d) => d.status !== 'closed')
  if (waiting.length === 0) return null
  return (
    <div className="mt-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-emerald-ink">
        Unblocks ({waiting.length})
      </h2>
      <p className="mb-2 text-sm text-fg-faint">Closing this task lets these run.</p>
      <DependencyList items={waiting} tone="emerald" />
    </div>
  )
}
