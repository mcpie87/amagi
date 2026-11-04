import { DetailRow, PILL } from '../badges.tsx'
import { Blockers, Unblocks } from './issue-dependencies.tsx'
import type { Issue } from './issue-model.ts'

/** Beads priority scale: 0 = most urgent. Fallback keeps unknown levels legible. */
const PRIORITY_SEVERITY = ['Critical', 'High', 'Medium', 'Low', 'Backlog']

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

/** The tracker's metadata behind a task: fields, blockers, acceptance criteria and description. */
export function IssueSpec({ issue }: { issue: Issue }) {
  return (
    <>
      <dl className="rounded-lg border border-line bg-surface px-4 py-3">
        <DetailRow
          label="priority"
          value={
            issue.priority === null
              ? null
              : `P${issue.priority} - ${PRIORITY_SEVERITY[issue.priority] ?? 'Unknown'}`
          }
        />
        <DetailRow label="type" value={issue.type} />
        <DetailRow label="assignee" value={issue.assignee} />
        <DetailRow label="labels" value={issue.labels.join(', ') || null} />
        <DetailRow label="parent" value={issue.parent} />
      </dl>
      <Blockers issue={issue} />
      <Unblocks issue={issue} />
      {issue.acceptanceCriteria !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Acceptance criteria
          </h2>
          <p className="whitespace-pre-wrap text-fg">{issue.acceptanceCriteria}</p>
        </div>
      )}
    </>
  )
}
