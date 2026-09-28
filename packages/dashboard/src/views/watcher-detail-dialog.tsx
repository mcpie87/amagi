import type { WorkerActivity } from '@amagi/core/run-service'
import { type DashboardState, watcherRunsFor } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { PILL } from '../badges.tsx'
import { useDateFormatPref } from '../date-format.ts'
import { fmtDateTime, fmtElapsed, fmtInterval, fmtLastRun, fmtUntil } from '../format.ts'

/**
 * Detail view for one background watcher (mention / pr-conflict / stall),
 * opened by clicking its slot in the Workers section. The watcher is looked
 * up live from the polled runner status, so the open dialog stays current.
 */
export function WatcherDetailDialog({
  selected,
  workers,
  state,
  onClose,
}: {
  selected: string | null
  workers: WorkerActivity[]
  state: DashboardState
  onClose: () => void
}) {
  const dateFormat = useDateFormatPref()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const open = selected !== null
  const [activeTab, setActiveTab] = useState<'history' | 'log'>('history')
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (open) {
      setActiveTab('history')
      dialog.showModal()
    } else if (dialog.open) dialog.close()
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
          <div className="detail-tabs mt-5 flex gap-1 border-b border-line">
            <button
              type="button"
              aria-pressed={activeTab === 'history'}
              onClick={() => setActiveTab('history')}
              className={`rounded-t px-3 py-1.5 text-sm ${
                activeTab === 'history'
                  ? 'border-b-2 border-sky-500 text-fg-strong'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              Run history
            </button>
            <button
              type="button"
              aria-pressed={activeTab === 'log'}
              onClick={() => setActiveTab('log')}
              className={`rounded-t px-3 py-1.5 text-sm ${
                activeTab === 'log'
                  ? 'border-b-2 border-sky-500 text-fg-strong'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              Live log
            </button>
          </div>
          {activeTab === 'history' && (
            <div className="border-t border-line pt-4">
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
                          <span className="ml-2 tabular-nums text-fg-faint">
                            {fmtElapsed((run.endedAt ?? Date.now()) - run.startedAt)}
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
          )}
          {activeTab === 'log' && (
            <div className="mt-4 border-t border-line pt-4">
              {liveLog.length === 0 ? (
                <p className="mt-2 text-xs text-fg-faint">no activity recorded yet</p>
              ) : (
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {liveLog.map((entry, index) => (
                    <li
                      key={`${entry.ts}-${index}`}
                      className={entry.level === 'error' ? 'text-red-ink' : 'text-fg-muted'}
                    >
                      {fmtDateTime(entry.ts, dateFormat)} {entry.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
