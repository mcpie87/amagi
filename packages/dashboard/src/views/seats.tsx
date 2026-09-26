import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { AgentLogView } from '../AgentLogView.tsx'
import { useDashboard, useSeats } from '../store.tsx'
import { EmptyState } from '../ui.tsx'

export function SeatsView() {
  const seats = useSeats()
  const { selected: selectedRepo, state } = useDashboard()
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)
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
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-fg-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Seat</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 font-medium">Holder</th>
                <th className="px-4 py-3 font-medium">Waiters</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {seats.map((seat) => (
                <tr
                  key={seat.seat}
                  onClick={() => setSelectedSeat(seat.seat)}
                  className={`cursor-pointer hover:bg-raised ${activeSeat?.seat === seat.seat ? 'bg-raised/50' : ''}`}
                >
                  <td className="px-4 py-3 font-medium text-fg">
                    <button
                      type="button"
                      aria-pressed={activeSeat?.seat === seat.seat}
                      onClick={() => setSelectedSeat(seat.seat)}
                      className="text-left hover:underline"
                    >
                      {seat.seat}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className={seat.state === 'held' ? 'text-amber-ink' : 'text-emerald-ink'}>
                      {seat.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {seat.holder === null ? (
                      '-'
                    ) : seat.holder.taskId === undefined ? (
                      `${seat.holder.repo} · ${seat.holder.watcher ?? 'agent'}`
                    ) : (
                      <Link
                        to="/tasks/$id"
                        params={{ id: seat.holder.taskId }}
                        className="font-medium text-fg hover:underline"
                      >
                        {`${seat.holder.repo} · ${seat.holder.watcher ?? seat.holder.taskId}`}
                      </Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {seat.waiters.length === 0
                      ? '-'
                      : seat.waiters
                          .map((waiter) => `${waiter.repo} · ${waiter.taskId}`)
                          .join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
