import type { MergeStatus, TaskState } from '@amagi/core/events'
import type { ReactNode } from 'react'

/** Shared pill shape; the tone supplies the tint, text and ring. */
export const PILL =
  'inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset'

const stateBadge: Record<TaskState, string> = {
  queued: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
  claimed: 'bg-neutral-soft text-fg ring-neutral-edge',
  worktree_ready: 'bg-sky-soft text-sky-ink ring-sky-edge',
  implementing: 'bg-blue-soft text-blue-ink ring-blue-edge',
  awaiting_answer: 'bg-amber-soft text-amber-ink ring-amber-edge',
  checks: 'bg-violet-soft text-violet-ink ring-violet-edge',
  reviewing: 'bg-violet-soft text-violet-ink ring-violet-edge',
  fixing: 'bg-blue-soft text-blue-ink ring-blue-edge',
  committed: 'bg-cyan-soft text-cyan-ink ring-cyan-edge',
  retrying: 'bg-orange-soft text-orange-ink ring-orange-edge',
  pr_open: 'bg-sky-soft text-sky-ink ring-sky-edge',
  pr_flagged: 'bg-amber-soft text-amber-ink ring-amber-edge',
  done: 'bg-emerald-soft text-emerald-ink ring-emerald-edge',
  no_pr: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
  needs_human: 'bg-red-soft text-red-ink ring-red-edge',
  abandoned: 'bg-neutral-soft text-fg-faint ring-neutral-edge',
  cancelled: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
}

export function Badge({ state }: { state: TaskState }) {
  return <span className={`${PILL} ${stateBadge[state]}`}>{state}</span>
}

const mergeTone: Record<MergeStatus, string> = {
  mergeable: 'bg-emerald-soft text-emerald-ink ring-emerald-edge',
  conflicted: 'bg-red-soft text-red-ink ring-red-edge',
  unknown: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
}

export const mergeLabel: Record<MergeStatus, string> = {
  mergeable: 'mergeable',
  conflicted: 'merge conflict',
  unknown: 'merge status unknown',
}

export function PrStatusChip({ status }: { status: MergeStatus }) {
  return <span className={`${PILL} ${mergeTone[status]}`}>{mergeLabel[status]}</span>
}

export function DetailRow({ label, value }: { label: string; value: string | ReactNode | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-fg-faint">{label}</dt>
      <dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd>
    </div>
  )
}
