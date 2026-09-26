import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
import { fmtTokens } from '@amagi/core/format'
import type {
  FleetWorkerStatus,
  RunnerResource,
  RunnerTask,
  WorkerActivity,
} from '@amagi/core/run-service'
import {
  currentAgentFor,
  currentUsageFor,
  type DashboardState,
  runHealth,
  runHealthNearLimit,
  watcherRunsFor,
} from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { apiBase } from '../api.ts'
import { Badge, PILL } from '../badges.tsx'
import { useDateFormatPref } from '../date-format.ts'
import {
  fmtBytes,
  fmtCpu,
  fmtDateTime,
  fmtElapsed,
  fmtInterval,
  fmtLastRun,
  fmtUntil,
} from '../format.ts'
import { useDashboard, useRunner } from '../store.tsx'

/** The tail of one task's ring buffer, live from the rAF-batched log store. */
function LastLogLine({ repo, taskId, attempt }: { repo: string; taskId: string; attempt: number }) {
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
            <span>harness: {worker.kind}</span>
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
  const title = taskInfo?.title ?? task?.title ?? taskId
  // The runner's per-task identity is authoritative for what is actually
  // running (rss/cpu arrive the same way); the SSE projection only fills in
  // when the polled status has not caught up.
  const agentLabel = taskInfo?.harness ?? agent?.harness ?? worker?.kind ?? 'unknown'
  const modelLabel = taskInfo?.model ?? agent?.model ?? 'unknown'
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
          {worker?.name ?? taskInfo?.workerName ?? 'Ad hoc run'}
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
        <span>harness: {agentLabel}</span>
        <span>model: {modelLabel}</span>
        <span>effort: {taskInfo?.effort ?? agent?.effort ?? worker?.effort ?? 'unknown'}</span>
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
 * Detail view for one background watcher (mention / pr-conflict / stall),
 * opened by clicking its slot in the Workers section. The watcher is looked
 * up live from the polled runner status, so the open dialog stays current.
 */
function WatcherDetailDialog({
  selected,
  workers,
  onClose,
}: {
  selected: string | null
  workers: WorkerActivity[]
  onClose: () => void
}) {
  const { state } = useDashboard()
  const dateFormat = useDateFormatPref()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const open = selected !== null
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open) dialog.showModal()
    else if (dialog.open) dialog.close()
  }, [open])
  if (selected === null) return null
  const watcher = workers.find((w) => `${w.repo}/${w.name}` === selected) ?? null
  const history = watcher === null ? [] : watcherRunsFor(state, watcher.repo, watcher.name)
  const historyGroups: (typeof history)[] = []
  for (const run of history) {
    const previous = historyGroups.at(-1)
    if (run.actions.length === 0 && run.error === null) {
      if (previous?.every((item) => item.actions.length === 0 && item.error === null)) {
        previous.push(run)
      } else {
        historyGroups.push([run])
      }
    } else {
      historyGroups.push([run])
    }
  }
  const liveLog = history
    .flatMap((run) => run.log)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 100)
  const statusPill =
    watcher === null
      ? PILL
      : watcher.status === 'active'
        ? `${PILL} bg-teal-soft text-teal-ink ring-teal-edge`
        : watcher.status === 'idle'
          ? `${PILL} bg-raised text-fg-muted ring-line`
          : `${PILL} bg-red-soft text-red-ink ring-red-edge`
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
      className="watcher-dialog"
    >
      {watcher === null ? (
        <p className="px-4 py-6 text-sm text-fg-faint">watcher no longer running</p>
      ) : (
        <div className="watcher-dialog-content p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`${PILL} bg-teal-soft text-teal-ink ring-teal-edge`}>
              {watcher.name}
            </span>
            <span className="font-medium text-fg">{watcher.repo}</span>
            <span className={statusPill}>{watcher.status}</span>
            {watcher.ok ? (
              <span className="text-xs text-emerald-ink">last tick ok</span>
            ) : (
              <span className="text-xs text-red-ink">last tick failed</span>
            )}
          </div>
          {watcher.detail !== null && watcher.detail !== undefined && (
            <p className="mt-3 text-sm text-fg">{watcher.detail}</p>
          )}
          {watcher.error !== null && (
            <p className="mt-1 break-words rounded border border-red-edge bg-red-soft px-2 py-1 text-xs text-red-ink">
              {watcher.error}
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-fg-faint">Last run</dt>
              <dd className="mt-0.5 text-fg">
                {watcher.lastRunAt > 0 ? fmtLastRun(watcher.lastRunAt) : 'never'}
              </dd>
              {watcher.lastRunAt > 0 && (
                <dd className="text-xs tabular-nums text-fg-faint">
                  {fmtDateTime(watcher.lastRunAt, dateFormat)}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-xs text-fg-faint">Next run</dt>
              <dd className="mt-0.5 text-fg">
                {watcher.status === 'off'
                  ? 'stopped'
                  : watcher.nextRunAt > 0
                    ? fmtUntil(watcher.nextRunAt)
                    : 'waiting for the first tick'}
              </dd>
              <dd className="text-xs text-fg-faint">every {fmtInterval(watcher.intervalMs)}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-faint">Total runs</dt>
              <dd className="mt-0.5 tabular-nums text-fg">{watcher.runs}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-faint">Success / failure</dt>
              <dd className="mt-0.5 tabular-nums text-fg">
                {watcher.successes} / {watcher.failures}
              </dd>
            </div>
          </dl>
          {watcher.counters.length > 0 && (
            <div className="mt-4">
              <dt className="text-xs text-fg-faint">What it did</dt>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {watcher.counters.map((c) => (
                  <span key={c.label} className={`${PILL} bg-raised text-fg-muted ring-line`}>
                    {c.label} {c.value}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="text-sm font-medium text-fg">Run history</h3>
            {history.length === 0 ? (
              <p className="mt-2 text-xs text-fg-faint">no runs recorded yet</p>
            ) : (
              <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
                {historyGroups.map((group) => {
                  if (group.length > 1) {
                    const newest = group[0]
                    const oldest = group[group.length - 1]
                    if (newest === undefined || oldest === undefined) return null
                    return (
                      <div
                        key={`noop-${newest.runId}-${oldest.runId}`}
                        className="rounded border border-line bg-surface/60 px-3 py-2 text-xs text-fg"
                      >
                        <span className="tabular-nums">
                          {fmtDateTime(newest.startedAt, dateFormat)} -{' '}
                          {fmtDateTime(oldest.startedAt, dateFormat)}
                        </span>
                        <span className="ml-2 text-fg-faint">{group.length} runs, 0 actions</span>
                      </div>
                    )
                  }
                  const run = group[0]
                  if (run === undefined) return null
                  return (
                    <details
                      key={run.runId}
                      className="rounded border border-line bg-surface/60 px-3 py-2"
                    >
                      <summary className="cursor-pointer text-xs text-fg">
                        <span className="tabular-nums">
                          {fmtDateTime(run.startedAt, dateFormat)}
                        </span>
                        <span
                          className={`ml-2 ${run.ok === false ? 'text-red-ink' : 'text-fg-muted'}`}
                        >
                          {run.endedAt === null ? 'running' : run.ok ? 'completed' : 'failed'}
                        </span>
                        <span className="ml-2 text-fg-faint">{run.actions.length} actions</span>
                      </summary>
                      {run.error !== null && (
                        <p className="mt-2 break-words text-xs text-red-ink">{run.error}</p>
                      )}
                      {run.actions.length === 0 ? (
                        <p className="mt-2 text-xs text-fg-faint">no actions recorded</p>
                      ) : (
                        <ul className="mt-2 space-y-1 text-xs">
                          {run.actions.map((action, index) => (
                            <li
                              key={`${run.runId}-${index}`}
                              className={
                                action.level === 'error' ? 'text-red-ink' : 'text-fg-muted'
                              }
                            >
                              {action.targetType === 'task' ? (
                                <Link
                                  to="/tasks/$id"
                                  params={{ id: action.targetId }}
                                  className="text-blue-ink hover:underline"
                                >
                                  task {action.targetId}
                                </Link>
                              ) : action.url !== undefined ? (
                                <a
                                  href={action.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-blue-ink hover:underline"
                                >
                                  {action.targetType === 'mention'
                                    ? `mention ${action.targetId} on PR #${action.prNumber ?? '?'}`
                                    : `PR #${action.prNumber ?? action.targetId}`}
                                </a>
                              ) : (
                                <span>
                                  {action.targetType === 'mention'
                                    ? `mention ${action.targetId} on PR #${action.prNumber ?? '?'}`
                                    : `${action.targetType} ${action.targetId}`}
                                </span>
                              )}
                              {': '}
                              {action.result}
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  )
                })}
              </div>
            )}
          </div>
          <div className="mt-4 border-t border-line pt-4">
            <h3 className="text-sm font-medium text-fg">Live log</h3>
            {liveLog.length === 0 ? (
              <p className="mt-2 text-xs text-fg-faint">no activity recorded yet</p>
            ) : (
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-[11px]">
                {liveLog.map((entry, index) => (
                  <li
                    key={`${entry.ts}-${index}`}
                    className={entry.level === 'error' ? 'text-red-ink' : 'text-fg-muted'}
                  >
                    {new Date(entry.ts).toLocaleTimeString()} {entry.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-line-strong bg-surface px-3 py-1 text-sm text-fg hover:bg-raised"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  )
}

/**
 * One row per configured worker plus any ad-hoc foreground run. Worker profile
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
      {error !== null && <span className="text-sm text-red-400">{error}</span>}
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
            ? 'bg-emerald-600 text-zinc-950 hover:bg-emerald-500'
            : 'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800'
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
        {status.fleet?.map((worker) => {
          const taskId =
            worker.taskId ??
            running.find((id) => status.tasks?.[id]?.workerId === worker.id) ??
            null
          return (
            <WorkerSlot
              key={worker.id}
              worker={worker}
              taskId={taskId}
              startedAt={taskId === null ? undefined : status.startedAt[taskId]}
              now={now}
              resource={taskId === null ? undefined : status.resources[taskId]}
              taskInfo={taskId === null ? undefined : status.tasks?.[taskId]}
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
              state={state}
              selected={selected}
            />
          ))}
        {(status.fleet?.length ?? 0) === 0 && running.length === 0 && (
          <div className="rounded-lg border border-line bg-surface/60 px-4 py-3 text-sm text-fg-dim">
            No workers configured
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
          onClose={() => setWatcherOpen(null)}
        />
      )}
    </section>
  )
}
