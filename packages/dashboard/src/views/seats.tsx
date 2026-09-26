import { useSeats } from '../store.tsx'
import { EmptyState } from '../ui.tsx'

export function SeatsView() {
  const seats = useSeats()

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
                <tr key={seat.seat}>
                  <td className="px-4 py-3 font-medium text-fg">{seat.seat}</td>
                  <td className="px-4 py-3">
                    <span className={seat.state === 'held' ? 'text-amber-ink' : 'text-emerald-ink'}>
                      {seat.state}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-fg-muted">
                    {seat.holder === null
                      ? '-'
                      : `${seat.holder.repo} · ${seat.holder.watcher ?? seat.holder.taskId ?? 'agent'}`}
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
    </div>
  )
}
