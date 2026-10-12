import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
import { fmtBytes, fmtCpu, fmtTokens } from '@amagi/core/format'
import type { FleetWorkerStatus, RunnerResource, RunnerTask } from '@amagi/core/run-service'
import {
  currentAgentFor,
  currentUsageFor,
  type DashboardState,
  runHealth,
  runHealthNearLimit,
} from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { apiBase } from '../api.ts'
import { Badge, PILL } from '../badges.tsx'
import { fmtElapsed, fmtLastRun } from '../format.ts'
import { useAgentLogBackfill, useDashboard, useRunner } from '../store.tsx'
import { WatcherDetailDialog } from './watcher-detail-dialog.tsx'

/** The tail of one task's ring buffer, live from the rAF-batched log store. */
function LastLogLine({ repo, taskId, attempt }: { repo: string; taskId: string; attempt: number }) {
  useAgentLogBackfill(repo, taskId, attempt)
  const key = agentLogKey(repo, taskId, attempt)
  useSyncExternalStore(
    (listener) => agentLogStore.subscribe(key, listener),
    () => agentLogStore.get(key).version,
  )
  const line = agentLogStore.get(key).at(-1)
  if (line === undefined || line.text === '') return null
  return <p className="mt-2 truncate font-mono text-xs text-fg-muted">{line.text}</p>
}

function WorkerSlot({
  worker,
  taskId,
  startedAt,
  now,
  resource,
  taskInfo,
  reviewWorker,
  state,
  selected,
}: {
  worker: FleetWorkerStatus | null
  taskId: string | null
  startedAt: number | undefined
  /** Wall-clock snapshot, advanced by one shared 1s interval in WorkersPanel. */
  now: number
  resource?: RunnerResource | undefined
  taskInfo?: RunnerTask | undefined
  reviewWorker?: FleetWorkerStatus | undefined
  state: DashboardState
  selected: string | null
}) {
  const task = taskId === null ? undefined : state.tasks[taskId]
  if (taskId === null) {
    return (
      <div className="rounded-lg border border-line bg-surface/60 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-fg">{worker?.name ?? 'Worker'}</span>
          <span className={`${PILL} bg-raised text-fg-muted ring-line`}>
            {worker === null ? 'idle' : worker.enabled ? 'idle' : 'disabled'}
          </span>
        </div>
        {worker !== null && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
            <span>
              harness: {worker.kind}-#{worker.displaySlot}
            </span>
            <span>model: {worker.model ?? 'default'}</span>
            <span>effort: {worker.effort ?? 'default'}</span>
            <span>seat: {worker.seat}</span>
            {worker.busy && <span>seat in use</span>}
          </div>
        )}
      </div>
    )
  }
  const agent = currentAgentFor(state, taskId)
  const reviewing = agent?.role === 'review'
  const title = taskInfo?.title ?? task?.title ?? taskId
  // The runner's per-task identity is authoritative for what is actually
  // running (rss/cpu arrive the same way); the SSE projection only fills in
  // when the polled status has not caught up.
  const agentLabel = reviewing
    ? (agent?.harness ?? 'unknown')
    : (taskInfo?.harness ?? agent?.harness ?? worker?.kind ?? 'unknown')
  const modelLabel = (reviewing ? agent?.model : taskInfo?.model) ?? agent?.model ?? 'unknown'
  const effortLabel =
    (reviewing ? agent?.effort : taskInfo?.effort) ?? agent?.effort ?? worker?.effort ?? 'unknown'
  const usage = currentUsageFor(state, taskId)
  const health = runHealth(state, taskId, now)
  const nearLimit = runHealthNearLimit(health)
  return (
    <div className="rounded-lg border border-line-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {startedAt !== undefined && (
          <span className="shrink-0 font-mono tabular-nums text-sm text-fg">
            {fmtElapsed(now - startedAt)}
          </span>
        )}
        <span
          className={`${PILL} ${taskInfo?.waitingOnSeat ? 'bg-amber-soft text-amber-ink ring-amber-edge' : 'bg-blue-soft text-blue-ink ring-blue-edge'}`}
        >
          {taskInfo?.waitingOnSeat
            ? `waiting on seat ${taskInfo.seat ?? worker?.seat ?? agentLabel}`
            : 'running'}
        </span>
        <span className="font-medium text-fg">
          {reviewing
            ? (reviewWorker?.name ?? 'Reviewer')
            : (worker?.name ?? taskInfo?.workerName ?? 'Ad hoc run')}
        </span>
        {nearLimit && (
          <span
            className="shrink-0 rounded bg-amber-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-ink ring-1 ring-inset ring-amber-edge"
            title={health.warnings.join('\n') || 'run is nearing a guard limit'}
          >
            near limit
          </span>
        )}
        <Link
          to="/tasks/$id"
          params={{ id: taskId }}
          className="flex min-w-0 items-baseline gap-x-3 hover:underline"
        >
          <span className="min-w-0 truncate font-medium">{title}</span>
          <span className="text-xs text-fg-faint">{task?.id ?? taskId}</span>
        </Link>
        {task !== undefined && <Badge state={task.state} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>
          harness:{' '}
          {reviewing || worker === null ? agentLabel : `${worker.kind}-#${worker.displaySlot}`}
        </span>
        <span>model: {modelLabel}</span>
        <span>effort: {effortLabel}</span>
        <span>seat: {taskInfo?.seat ?? worker?.seat ?? agent?.seat ?? agentLabel}</span>
        <span>
          ctx: {usage === null ? 'unknown' : fmtTokens(usage.inputTokens + usage.outputTokens)}
        </span>
        {resource !== undefined && (
          <>
            <span>rss: {fmtBytes(resource.rssBytes)}</span>
            <span>cpu: {fmtCpu(resource.cpuMs)}</span>
            <span>procs: {resource.processes}</span>
          </>
        )}
      </div>
      {selected !== null && (
        <LastLogLine repo={selected} taskId={taskId} attempt={task?.attempt ?? 1} />
      )}
    </div>
  )
}

/**
 * One row per running worker plus any ad-hoc foreground run. Worker profile
 * and runtime data both come from the selected repo's runner status; the
 * summary strip aggregates resource use over live agent trees.
 */
function AutoQueueToggle() {
  const { status } = useRunner()
  const { selected } = useDashboard()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fromStatus = status?.autoQueue ?? false
  const [on, setOn] = useState(fromStatus)
  useEffect(() => setOn(fromStatus), [fromStatus])
  const runnerRepo = selected

  const toggle = async () => {
    if (runnerRepo === null || busy) return
    const next = !on
    setBusy(true)
    setError(null)
    setOn(next)
    try {
      const res = await fetch(`${apiBase}/api/repos/${runnerRepo}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoQueue: next }),
      })
      if (!res.ok) {
        setOn(!next)
        setError((await res.json())?.error ?? `HTTP ${res.status}`)
      }
    } catch {
      setOn(!next)
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error !== null && <span className="text-sm text-red-ink">{error}</span>}
      <button
        type="button"
        disabled={busy || runnerRepo === null}
        onClick={() => void toggle()}
        title={
          on
            ? 'free runner slots get filled automatically as tasks become claimable'
            : 'dispatch is manual: click Run next (or retry) to start a task'
        }
        className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-50 ${
          on
            ? 'bg-emerald-ink text-on-solid hover:opacity-90'
            : 'border border-line-strong bg-surface text-fg-muted hover:bg-raised'
        }`}
      >
        Auto queue: {on ? 'on' : 'off'}
      </button>
    </div>
  )
}

export function WorkersPanel() {
  const { status } = useRunner()
  const { state, selected } = useDashboard()
  const [now, setNow] = useState(() => Date.now())
  const [watcherOpen, setWatcherOpen] = useState<string | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (status === null) return null
  const running = status.running
  const total = running.reduce(
    (acc, id) => {
      const r = status.resources[id]
      return r === undefined
        ? acc
        : {
            processes: acc.processes + r.processes,
            rssBytes: acc.rssBytes + r.rssBytes,
            cpuMs: acc.cpuMs + r.cpuMs,
          }
    },
    { processes: 0, rssBytes: 0, cpuMs: 0 },
  )
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Workers ({status.busySeats}/{status.totalSeats} seats)
        </h2>
        <AutoQueueToggle />
      </div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">{status.name}</span>
        <span>rss: {fmtBytes(total.rssBytes)}</span>
        <span>cpu: {fmtCpu(total.cpuMs)}</span>
        <span>procs: {total.processes}</span>
      </div>
      <div className="space-y-2">
        {status.fleet?.flatMap((worker) => {
          const taskId =
            worker.taskId ??
            running.find((id) => status.tasks?.[id]?.workerId === worker.id) ??
            null
          if (taskId === null) return []
          return (
            <WorkerSlot
              key={worker.id}
              worker={worker}
              taskId={taskId}
              startedAt={taskId === null ? undefined : status.startedAt[taskId]}
              now={now}
              resource={taskId === null ? undefined : status.resources[taskId]}
              taskInfo={taskId === null ? undefined : status.tasks?.[taskId]}
              reviewWorker={status.fleet?.find(
                (candidate) => candidate.enabled && candidate.roles.includes('review'),
              )}
              state={state}
              selected={selected}
            />
          )
        })}
        {running
          .filter((id) => {
            const taskInfo = status.tasks?.[id]
            return (
              taskInfo?.workerId == null ||
              !status.fleet?.some((worker) => worker.id === taskInfo.workerId)
            )
          })
          .map((taskId) => (
            <WorkerSlot
              key={`adhoc:${taskId}`}
              worker={null}
              taskId={taskId}
              startedAt={status.startedAt[taskId]}
              now={now}
              resource={status.resources[taskId]}
              taskInfo={status.tasks?.[taskId]}
              reviewWorker={status.fleet?.find(
                (candidate) => candidate.enabled && candidate.roles.includes('review'),
              )}
              state={state}
              selected={selected}
            />
          ))}
        {running.length === 0 && (
          <div className="rounded-lg border border-line bg-surface/60 px-4 py-3 text-sm text-fg-dim">
            No agents running
          </div>
        )}
      </div>
      {status.workers !== undefined && status.workers.length > 0 && (
        <div className="mt-2 space-y-2">
          {status.workers.map((w) => (
            <button
              key={`${w.repo}/${w.name}`}
              type="button"
              onClick={() => setWatcherOpen(`${w.repo}/${w.name}`)}
              title="open watcher detail"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/60 px-4 py-2 text-left text-xs text-fg-muted hover:bg-raised"
            >
              <span className={`${PILL} bg-teal-soft text-teal-ink ring-teal-edge`}>{w.name}</span>
              <span className="font-medium text-fg">{w.repo}</span>
              <span>last run: {fmtLastRun(w.lastRunAt)}</span>
              {w.error === null ? (
                w.detail !== null && w.detail !== undefined ? (
                  <span>{w.detail}</span>
                ) : (
                  <span>{w.counters.map((c) => `${c.label} ${c.value}`).join(' · ')}</span>
                )
              ) : (
                <span className="text-red-ink">error: {w.error}</span>
              )}
              <span className="ml-auto text-fg-faint">details ›</span>
            </button>
          ))}
        </div>
      )}
      {status.workers !== undefined && (
        <WatcherDetailDialog
          selected={watcherOpen}
          workers={status.workers}
          state={state}
          onClose={() => setWatcherOpen(null)}
        />
      )}
    </section>
  )
}
