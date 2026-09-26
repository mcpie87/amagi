import { fmtDuration } from '@amagi/core/format'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AgentLogView } from '../AgentLogView.tsx'
import { useDashboard, useSeats } from '../store.tsx'
import { EmptyState } from '../ui.tsx'

export function SeatsView() {
  const seats = useSeats()
  const { selected: selectedRepo, selectRepo, state } = useDashboard()
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const activeSeat = seats?.find((seat) => seat.seat === selectedSeat) ?? seats?.[0]
  const holders = seats?.filter((seat) => seat.holder?.taskId !== undefined) ?? []

  const attemptFor = (repo: string, taskId: string) =>
    repo === selectedRepo ? (state.tasks[taskId]?.attempt ?? 1) : 1

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Seats</h1>
          <p className="text-sm text-fg-muted">
            Credential seats across all registered repositories.
          </p>
        </div>
      </header>
      {seats === null ? (
        <EmptyState title="Seat status unavailable">Could not load seat status.</EmptyState>
      ) : seats.length === 0 ? (
        <EmptyState title="No configured seats">
          Configure a worker, watcher, or implement seat to list it here.
        </EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {seats.map((seat) => {
            const empty =
              seat.holder === null && seat.waiters.length === 0 && seat.eligible.length === 0
            const elapsed = (since: number | null | undefined) =>
              since === null || since === undefined ? 'time unavailable' : fmtDuration(now - since)
            const taskLink = (task: (typeof seat.waiters)[number]) => (
              <Link
                key={`${task.repo}/${task.taskId}`}
                to="/tasks/$id"
                params={{ id: task.taskId }}
                onClick={() => selectRepo(task.repo)}
                className="font-medium text-fg hover:underline"
              >
                {task.repo} · {task.title}
              </Link>
            )
            return (
              <article
                key={seat.seat}
                className={`rounded-lg border border-line bg-surface p-4 ${activeSeat?.seat === seat.seat ? 'ring-1 ring-accent' : ''}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    aria-pressed={activeSeat?.seat === seat.seat}
                    onClick={() => setSelectedSeat(seat.seat)}
                    className="text-left font-semibold text-fg hover:underline"
                  >
                    {seat.seat}
                  </button>
                  <span className={seat.state === 'held' ? 'text-amber-ink' : 'text-emerald-ink'}>
                    {seat.state === 'held' ? 'Held' : empty ? 'Idle · no queued work' : 'Free'}
                  </span>
                </div>
                <div className="mt-3 space-y-3 text-sm">
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                      Current holder
                    </h3>
                    {seat.holder === null ? (
                      <p className="mt-1 text-fg-muted">None</p>
                    ) : seat.holder.taskId === undefined ? (
                      <p className="mt-1 text-fg">
                        {seat.holder.repo} · {seat.holder.watcher ?? 'agent'}
                        <span className="ml-2 text-fg-muted">
                          {seat.holder.status} · {elapsed(seat.holder.since)}
                        </span>
                      </p>
                    ) : (
                      <p className="mt-1">
                        <Link
                          to="/tasks/$id"
                          params={{ id: seat.holder.taskId }}
                          onClick={() => {
                            const holder = seat.holder
                            if (holder !== null) selectRepo(holder.repo)
                          }}
                          className="font-medium text-fg hover:underline"
                        >
                          {seat.holder.repo} · {seat.holder.title ?? seat.holder.taskId}
                        </Link>
                        <span className="ml-2 text-fg-muted">
                          {seat.holder.status ?? 'running'} · {elapsed(seat.holder.since)}
                        </span>
                      </p>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                      Waiting for this seat
                      {seat.waiters.length > 0 ? ` · ${seat.waiters.length}` : ''}
                    </h3>
                    {seat.waiters.length === 0 ? (
                      <p className="mt-1 text-fg-muted">No tasks waiting</p>
                    ) : (
                      <ol className="mt-1 space-y-1">
                        {seat.waiters.map((task, index) => (
                          <li
                            key={`${task.repo}/${task.taskId}`}
                            className="flex justify-between gap-3"
                          >
                            <span>
                              {index + 1}. {taskLink(task)}
                            </span>
                            <span className="shrink-0 text-fg-muted">
                              {task.status} · waiting {elapsed(task.since)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                  <div>
                    <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                      Ready to start{seat.eligible.length > 0 ? ` · ${seat.eligible.length}` : ''}
                    </h3>
                    {seat.eligible.length === 0 ? (
                      <p className="mt-1 text-fg-muted">No eligible work</p>
                    ) : (
                      <ol className="mt-1 space-y-1">
                        {seat.eligible.map((task, index) => (
                          <li
                            key={`${task.repo}/${task.taskId}`}
                            className="flex justify-between gap-3"
                          >
                            <span>
                              {index + 1}. {taskLink(task)}
                            </span>
                            <span className="shrink-0 text-fg-muted">
                              {task.status} · age {elapsed(task.since)}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
      {activeSeat !== undefined && (
        <section className="mt-6 space-y-3">
          <h2 className="text-lg font-semibold">{activeSeat.seat}</h2>
          <div className="rounded-lg border border-line bg-surface p-4">
            <h3 className="text-sm font-medium text-fg">Current activity</h3>
            {activeSeat.holder === null ? (
              <p className="mt-1 text-sm text-fg-muted">Seat is {activeSeat.state}.</p>
            ) : activeSeat.holder.taskId === undefined ? (
              <p className="mt-1 text-sm text-fg-muted">
                {activeSeat.holder.repo} · {activeSeat.holder.watcher ?? 'agent'} is using this
                seat.
              </p>
            ) : (
              <p className="mt-1 text-sm text-fg-muted">
                {state.tasks[activeSeat.holder.taskId]?.title ?? activeSeat.holder.taskId} ·{' '}
                {state.tasks[activeSeat.holder.taskId]?.state ?? 'running'}
              </p>
            )}
          </div>
          {activeSeat.holder?.taskId !== undefined && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-fg">Live log</h3>
              <AgentLogView
                repo={activeSeat.holder.repo}
                taskId={activeSeat.holder.taskId}
                attempt={attemptFor(activeSeat.holder.repo, activeSeat.holder.taskId)}
              />
            </div>
          )}
        </section>
      )}
      {seats !== null && seats.length > 0 && (
        <section className="mt-8 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Combined live logs</h2>
            <p className="text-sm text-fg-muted">Live output from current seat holders.</p>
          </div>
          {holders.length === 0 ? (
            <EmptyState title="No active seat logs">
              Logs appear here while seat holders run tasks.
            </EmptyState>
          ) : (
            holders.map(({ seat, holder }) => {
              if (holder?.taskId === undefined) return null
              return (
                <div key={seat} className="rounded-lg border border-line bg-surface p-4">
                  <h3 className="mb-2 text-sm font-medium text-fg">
                    {seat} · {holder.repo} · {holder.taskId}
                  </h3>
                  <AgentLogView
                    repo={holder.repo}
                    taskId={holder.taskId}
                    attempt={attemptFor(holder.repo, holder.taskId)}
                  />
                </div>
              )
            })
          )}
        </section>
      )}
    </div>
  )
}
