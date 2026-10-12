import { useState } from 'react'
import { IssueBadge } from './issue-details.tsx'
import type { Issue } from './issue-model.ts'

const ISSUE_STATES: Issue['status'][] = ['open', 'in_progress', 'blocked', 'closed']

const columnHeader: Record<Issue['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
}

const columnDot: Record<Issue['status'], string> = {
  open: 'bg-fg-faint',
  in_progress: 'bg-blue-ink',
  blocked: 'bg-red-ink',
  closed: 'bg-emerald-ink',
}

type IssuesViewMode = 'kanban' | 'list'

export function IssueBoard({
  issues,
  error,
  hasRepo,
  onOpenIssue,
  onCreate,
}: {
  issues: Issue[]
  error: string | null
  hasRepo: boolean
  onOpenIssue: (id: string) => void
  onCreate: () => void
}) {
  const [status, setStatus] = useState<Issue['status'] | 'all'>('all')
  const [search, setSearch] = useState('')
  const [view, setView] = useState<IssuesViewMode>(() => {
    try {
      return localStorage.getItem('amagi:issue-view') === 'list' ? 'list' : 'kanban'
    } catch {
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
  const q = search.trim().toLowerCase()
  const filtered = status === 'all' ? issues : issues.filter((issue) => issue.status === status)
  const searched =
    q === ''
      ? filtered
      : filtered.filter(
          (issue) => issue.title.toLowerCase().includes(q) || issue.id.toLowerCase().includes(q),
        )

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent"
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
          {hasRepo && (
            <button
              type="button"
              onClick={onCreate}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-on-solid hover:bg-accent/90"
            >
              New task
            </button>
          )}
        </div>
      </div>
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
                        onClick={() => onOpenIssue(issue.id)}
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
                onClick={() => onOpenIssue(issue.id)}
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
    </>
  )
}
