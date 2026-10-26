import type { PrInfo } from '@amagi/core'
import { fmtTokens } from '@amagi/core/format'
import type { ReadyTask } from '@amagi/core/run-service'
import { activeTasks, type ProjectedTask, tasksNeedingAttention } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { Badge } from '../badges.tsx'
import { useDateFormatPref } from '../date-format.ts'
import { fmtAgo, fmtDateTime, fmtRetryIn } from '../format.ts'
import { pollOk, usePoll } from '../hub-client.ts'
import { useDashboard, useReadyQueue, useRunner } from '../store.tsx'
import { EmptyState, Icon } from '../ui.tsx'
import { CloseButtons } from './task-actions.tsx'
import { WorkersPanel } from './workers.tsx'

const metricTone = {
  red: { box: 'border-red-edge bg-red-soft', value: 'text-red-ink' },
  amber: { box: 'border-amber-edge bg-amber-soft', value: 'text-amber-ink' },
  none: { box: 'border-line bg-surface', value: 'text-fg-strong' },
} as const

function Metric({
  label,
  value,
  tone,
  onClick,
}: {
  label: string
  value: string
  tone?: 'red' | 'amber'
  onClick?: () => void
}) {
  const t = metricTone[tone ?? 'none']
  const body = (
    <>
      <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${t.value}`}>{value}</div>
    </>
  )
  if (onClick === undefined) {
    return <div className={`metric rounded-lg border px-4 py-3 ${t.box}`}>{body}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`metric rounded-lg border px-4 py-3 text-left ${t.box} hover:border-line-strong`}
    >
      {body}
    </button>
  )
}

function ReadyQueueDialog({ tasks, onClose }: { tasks: ReadyTask[]; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    dialog.showModal()
  }, [])
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc already closes via onCancel; this only handles backdrop clicks.
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="ready-queue-dialog"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">Ready to run ({tasks.length})</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {tasks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-faint">nothing in the ready queue</p>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
          {tasks.map((task) => (
            <li key={task.id} className="px-4 py-2.5 text-sm">
              {task.url === null ? (
                <span className="block truncate font-medium text-fg">{task.title}</span>
              ) : (
                <a
                  href={task.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-medium text-fg hover:underline"
                >
                  {task.title}
                </a>
              )}
              <span className="block truncate text-xs text-fg-faint">
                {task.id}
                {task.priority !== null && ` · P${task.priority}`}
                {task.type !== null && ` · ${task.type}`}
              </span>
              {task.claimSkip !== undefined && (
                <span className="block truncate text-xs text-fg-muted">
                  {task.claimSkip.state}: {task.claimSkip.reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </dialog>
  )
}

/** The forge call takes seconds, so a revisit shows the last list while it refreshes. */
const lastMergeablePrs = new Map<string, PrInfo[]>()

/**
 * Open PRs the forge reports as currently mergeable, the dashboard twin of the
 * check-prs CLI command. Polled, not streamed: the forge computes mergeability
 * asynchronously and it changes slowly, so a slow refresh is enough and each
 * poll is one forge call, not one per PR.
 */
function MergeablePrsPanel() {
  const { selected } = useDashboard()
  const dateFormat = useDateFormatPref()
  const [prs, setPrs] = useState<PrInfo[] | null>(() =>
    selected === null ? null : (lastMergeablePrs.get(selected) ?? null),
  )

  const result = usePoll(
    selected === null ? null : `${apiBase}/api/repos/${selected}/mergeable-prs`,
    10_000,
  )

  useEffect(() => {
    if (selected !== null) setPrs(lastMergeablePrs.get(selected) ?? null)
  }, [selected])

  useEffect(() => {
    if (selected === null || result === undefined) return
    // A repo without a forge driver simply has no mergeable PRs to show.
    if (result?.status === 501) {
      lastMergeablePrs.set(selected, [])
      setPrs([])
    } else if (pollOk(result)) {
      const list = (result.body as { prs: PrInfo[] }).prs
      lastMergeablePrs.set(selected, list)
      setPrs(list)
    }
    // A transient failure keeps the last good list, not a spinner.
  }, [result, selected])

  if (selected === null || prs === null) return null

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Mergeable PRs ({prs.length})
        </h2>
        <span className="text-xs text-fg-faint">from the forge, refreshed every 10s</span>
      </div>
      {prs.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-faint">
          No open PRs are mergeable right now.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {prs.map((p) => (
            <li key={p.url} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate hover:underline"
              >
                <span className="font-medium text-fg">#{p.number}</span>{' '}
                <span className="text-sky-ink">{p.title}</span>
              </a>
              <span className="shrink-0 text-xs text-fg-faint">
                {p.headRefName} &rarr; {p.baseRefName}
              </span>
              {p.createdAt !== '' && (
                <time
                  dateTime={p.createdAt}
                  title={fmtDateTime(new Date(p.createdAt), dateFormat)}
                  className="shrink-0 text-xs text-fg-faint"
                >
                  created {fmtAgo(Date.parse(p.createdAt))}
                </time>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

type ResolveAllResult = { queued: number; skipped: number; failures: string[] }

/**
 * Queues every open PR of the repository on the PR conflict watcher, the same
 * path the per-task Queue conflict resolution button takes.
 */
function ResolveAllConflictsButton({ repo }: { repo: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<
    { kind: 'ok'; body: ResolveAllResult } | { kind: 'error'; text: string } | null
  >(null)

  const queue = async () => {
    if (
      !window.confirm(
        `Queue conflict resolution for every open PR in ${repo}? Each one gets the base branch merged in and pushed.`,
      )
    ) {
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/resolve-conflicts`, { method: 'POST' })
      if (!res.ok) {
        setResult({ kind: 'error', text: (await res.json())?.error ?? `HTTP ${res.status}` })
      } else {
        setResult({ kind: 'ok', body: (await res.json()) as ResolveAllResult })
      }
    } catch {
      setResult({ kind: 'error', text: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => void queue()}
        title="Queue conflict resolution for every run in this repository with an open PR"
        className="rounded border border-red-edge bg-red-soft px-3 py-1.5 text-sm text-red-ink hover:bg-red-soft-hover disabled:opacity-50"
      >
        {busy ? 'Queuing…' : 'Resolve conflicts on all PRs'}
      </button>
      {result !== null && (
        <div className="absolute right-0 z-10 mt-1 w-72 rounded border border-line bg-surface px-3 py-2 text-sm shadow">
          {result.kind === 'error' ? (
            <p className="text-red-ink">{result.text}</p>
          ) : (
            <>
              <p className="text-emerald-ink">
                {result.body.queued} queued, {result.body.skipped} skipped
              </p>
              {result.body.failures.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-red-ink">
                  {result.body.failures.map((failure) => (
                    <li key={failure}>{failure}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-1 text-xs text-fg-faint hover:underline"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  )
}

type UsageRate = { seat: string; calls: number; tokens: number }

function SeatUsagePanel() {
  const [rates, setRates] = useState<UsageRate[] | null>(null)
  const result = usePoll(`${apiBase}/api/usage-rates`, 10_000)

  useEffect(() => {
    if (pollOk(result)) setRates((result.body as { rates: UsageRate[] }).rates)
  }, [result])

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Harness calls by seat
        </h2>
        <span className="text-xs text-fg-faint">
          last 60s across registered repos; Claude/Codex turns, OpenCode steps; refreshed every 10s
        </span>
      </div>
      {rates === null ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-faint">
          loading usage rates...
        </p>
      ) : rates.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-faint">
          No usage reported in the last minute.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-fg-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Seat</th>
                <th className="px-4 py-2 text-right font-medium">Calls/min</th>
                <th className="px-4 py-2 text-right font-medium">Tokens/min</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...rates]
                .sort((a, b) => b.tokens - a.tokens)
                .map((rate) => (
                  <tr key={rate.seat}>
                    <td className="px-4 py-2 font-medium text-fg">{rate.seat}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{rate.calls}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmtTokens(rate.tokens)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function OverviewView() {
  const { state, selected } = useDashboard()
  const { status } = useRunner()
  const readyQueue = useReadyQueue()
  const [search, setSearch] = useState('')
  const [readyQueueOpen, setReadyQueueOpen] = useState(false)
  const queue = activeTasks(state)
  const attention = tasksNeedingAttention(state)
  const openQuestions = Object.values(state.questions).filter((q) => q.resolvedAt === null).length

  const q = search.trim().toLowerCase()
  const visible =
    q === ''
      ? queue
      : queue.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))

  const workers = status === null ? '-' : `${status.busySeats}/${status.totalSeats}`

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-fg-faint">Live runs, capacity and anything that needs you.</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search runs…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent"
          />
          {selected !== null && <ResolveAllConflictsButton key={selected} repo={selected} />}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="Active runs" value={String(queue.length)} />
        <Metric
          label="Ready to run"
          value={String(readyQueue.length)}
          onClick={() => setReadyQueueOpen(true)}
        />
        <Metric label="Workers busy" value={workers} />
        <Metric
          label="Needs attention"
          value={String(attention.length)}
          {...(attention.length > 0 ? { tone: 'red' as const } : {})}
        />
        <Metric
          label="Open questions"
          value={String(openQuestions)}
          {...(openQuestions > 0 ? { tone: 'amber' as const } : {})}
        />
      </div>

      <MergeablePrsPanel />

      <SeatUsagePanel />

      <WorkersPanel />

      {attention.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-ink">
            Needs attention ({attention.length})
          </h2>
          <RunList
            tasks={attention}
            showReason
            rowClass="attention-row"
            {...(selected === null
              ? {}
              : {
                  action: (task: ProjectedTask) => (
                    <CloseButtons repo={selected} taskId={task.id} state={task.state} />
                  ),
                })}
          />
        </section>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Runs ({visible.length})
        </h2>
        <Link to="/activity" className="text-sm text-sky-ink hover:underline">
          activity feed &rarr;
        </Link>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon="runs" title={q === '' ? 'No active runs' : 'No matching runs'}>
          {q === ''
            ? 'Claim the next ready issue with Run next, and it will show up here.'
            : `Nothing in the queue matches "${search}".`}
        </EmptyState>
      ) : (
        <RunList tasks={visible} showReason={false} />
      )}

      {readyQueueOpen && (
        <ReadyQueueDialog tasks={readyQueue} onClose={() => setReadyQueueOpen(false)} />
      )}
    </section>
  )
}

export function RunList({
  tasks,
  showReason,
  action,
  rowClass = 'run-row',
}: {
  tasks: ProjectedTask[]
  showReason: boolean
  action?: (task: ProjectedTask) => ReactNode
  rowClass?: string
}) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {tasks.map((task) => (
        <li key={task.id} className={`${rowClass} flex items-center`}>
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-raised"
          >
            <Badge state={task.state} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{task.title}</span>
              <span className="block truncate text-xs text-fg-faint">{task.id}</span>
              {showReason && task.statusReason !== null && (
                <span className="block truncate text-xs text-fg-muted">{task.statusReason}</span>
              )}
              {task.state === 'retrying' && (
                <span className="block truncate text-xs text-orange-ink">
                  {task.retryAt !== null ? `retrying in ${fmtRetryIn(task.retryAt)}` : 'retrying'}
                  {task.lastError !== null && ` · ${task.lastError}`}
                </span>
              )}
            </span>
          </Link>
          {action?.(task)}
        </li>
      ))}
    </ul>
  )
}
