import { errMsg } from '@amagi/core/errors'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { DetailRow, PILL } from '../badges.tsx'
import { Markdown } from '../markdown.tsx'
import { IssueCloseButton } from './issue-close.tsx'
import { Blockers, Unblocks } from './issue-dependencies.tsx'
import { fetchIssue, type Issue } from './issue-model.ts'

export function IssueBadge({ issue }: { issue: Issue }) {
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

export function IssueDetails({
  issue,
  back,
  actions,
}: {
  issue: Issue
  back: ReactNode
  actions?: ReactNode
}) {
  return (
    <section>
      {back}
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{issue.title}</h1>
        <IssueBadge issue={issue} />
        {actions}
      </div>
      <p className="mt-1 text-sm text-fg-faint">
        {issue.id}
        {issue.parent ? ` · child of ${issue.parent}` : ''}
      </p>
      <dl className="mt-6 rounded-lg border border-line bg-surface px-4 py-3">
        <DetailRow label="priority" value={issue.priority === null ? null : `P${issue.priority}`} />
        <DetailRow label="type" value={issue.type} />
        <DetailRow label="assignee" value={issue.assignee} />
        <DetailRow label="labels" value={issue.labels.join(', ') || null} />
      </dl>
      <Blockers issue={issue} />
      <Unblocks issue={issue} />
      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Description
        </h2>
        <Markdown text={issue.description || 'No description.'} />
      </div>
      {issue.acceptanceCriteria !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Acceptance criteria
          </h2>
          <p className="whitespace-pre-wrap text-fg">{issue.acceptanceCriteria}</p>
        </div>
      )}
    </section>
  )
}

export function EpicDetails({
  id,
  title,
  status,
  totalChildren,
  closedChildren,
  childIssues,
  detailError,
  childrenError,
  loading,
  back,
  actions,
  onOpenIssue,
}: {
  id: string
  title: string
  status: string
  totalChildren: number
  closedChildren: number
  childIssues: Issue[]
  detailError: string | null
  childrenError: string | null
  loading: boolean
  back: ReactNode
  actions?: ReactNode
  onOpenIssue: (id: string) => void
}) {
  return (
    <section>
      {back}
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {status === 'closed' ? (
          <span className="rounded bg-raised px-2 py-0.5 text-xs text-fg-muted">Closed</span>
        ) : (
          actions
        )}
      </div>
      <p className="mt-1 text-sm text-fg-faint">
        {id} · {closedChildren}/{totalChildren} children done
      </p>
      {detailError !== null && <p className="mt-2 text-sm text-red-ink">{detailError}</p>}
      <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-fg-muted">
        Child tasks ({childIssues.length})
      </h2>
      {childrenError !== null ? (
        <p className="text-sm text-red-ink">{childrenError}</p>
      ) : loading ? (
        <p className="text-sm text-fg-faint">Loading child tasks...</p>
      ) : childIssues.length === 0 ? (
        <p className="text-sm text-fg-faint">No child tasks.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {childIssues.map((child) => (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => onOpenIssue(child.id)}
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

export function IssueDetailView({
  repo,
  id,
  refresh,
  back,
  actions,
  onEdit,
  onClosed,
}: {
  repo: string | null
  id: string
  refresh: number
  back: ReactNode
  actions?: ReactNode
  onEdit: (issue: Issue) => void
  onClosed: () => void
}) {
  const { issue, error } = useIssueDetail(repo, id, refresh)

  const selectedIssue = issue?.id === id ? issue : null
  if (selectedIssue === null) {
    return (
      <section>
        {back}
        {error !== null ? (
          <p className="mt-4 text-red-ink">{error}</p>
        ) : (
          <p className="mt-4 text-fg-faint">Loading {id}...</p>
        )}
      </section>
    )
  }
  return (
    <IssueDetails
      issue={selectedIssue}
      back={back}
      actions={
        <>
          {repo !== null && (
            <button
              type="button"
              onClick={() => onEdit(selectedIssue)}
              className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
            >
              Edit
            </button>
          )}
          {repo !== null && selectedIssue.status !== 'closed' && (
            <IssueCloseButton
              key={selectedIssue.id}
              repo={repo}
              issue={selectedIssue}
              onClosed={onClosed}
            />
          )}
          {selectedIssue.status !== 'closed' && actions}
        </>
      }
    />
  )
}

export function EpicDetailView({
  repo,
  id,
  refresh,
  epic,
  back,
  actions,
  onOpenIssue,
  onClosed,
}: {
  repo: string | null
  id: string
  refresh: number
  epic: {
    id: string
    title: string
    status: string
    totalChildren: number
    closedChildren: number
  } | null
  back: ReactNode
  actions?: ReactNode
  onOpenIssue: (id: string) => void
  onClosed: () => void
}) {
  const { issue, error: detailError } = useIssueDetail(repo, id, refresh)
  const [children, setChildren] = useState<Issue[]>([])
  const [loading, setLoading] = useState(false)
  const [childrenError, setChildrenError] = useState<string | null>(null)

  useEffect(() => {
    void refresh
    let active = true
    setChildren([])
    setLoading(true)
    setChildrenError(null)
    if (repo === null) {
      setLoading(false)
      return () => {
        active = false
      }
    }
    fetch(`${apiBase}/api/repos/${repo}/issues/${id}/children`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then((items) => {
        if (active) setChildren(items)
      })
      .catch((err: unknown) => {
        if (active) setChildrenError(errMsg(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [repo, id, refresh])

  const selectedIssue = issue?.id === id ? issue : null
  const selectedEpic =
    epic ??
    (selectedIssue === null
      ? null
      : {
          id: selectedIssue.id,
          title: selectedIssue.title,
          status: selectedIssue.status,
          totalChildren: children.length,
          closedChildren: children.filter((child) => child.status === 'closed').length,
        })
  return (
    <EpicDetails
      id={id}
      title={selectedEpic?.title ?? (detailError === null ? 'Loading epic...' : id)}
      status={selectedEpic?.status ?? ''}
      totalChildren={selectedEpic?.totalChildren ?? children.length}
      closedChildren={
        selectedEpic?.closedChildren ?? children.filter((child) => child.status === 'closed').length
      }
      childIssues={children}
      detailError={detailError}
      childrenError={childrenError}
      loading={loading}
      back={back}
      actions={
        <>
          {repo !== null && selectedIssue !== null && selectedIssue.status !== 'closed' && (
            <IssueCloseButton
              key={selectedIssue.id}
              repo={repo}
              issue={selectedIssue}
              onClosed={onClosed}
            />
          )}
          {actions}
        </>
      }
      onOpenIssue={onOpenIssue}
    />
  )
}

function useIssueDetail(repo: string | null, id: string, refresh: number) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void refresh
    let active = true
    setError(null)
    if (repo === null)
      return () => {
        active = false
      }
    fetchIssue(repo, id)
      .then((detail) => {
        if (active) setIssue(detail)
      })
      .catch((err: unknown) => {
        if (active) setError(errMsg(err))
      })
    return () => {
      active = false
    }
  }, [repo, id, refresh])

  return { issue, error }
}
