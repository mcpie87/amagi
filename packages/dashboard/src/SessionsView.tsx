import { fmtDuration, fmtTokens } from '@amagi/core/format'
import { type SessionView, sessionsFromEvents } from '@amagi/core/sessions'
import { useMemo } from 'react'
import { useDashboard } from './store.tsx'

type Group = {
  harness: string
  model: string
  count: number
  completed: number
  totalMs: number
  usedTokens: number
  cachedTokens: number
  costUsd: number
}

function groupByHarnessModel(sessions: SessionView[]): Group[] {
  const groups = new Map<string, Group>()
  for (const session of sessions) {
    const key = `${session.harness}\u0000${session.model ?? 'unknown'}`
    const group = groups.get(key) ?? {
      harness: session.harness,
      model: session.model ?? 'unknown',
      count: 0,
      completed: 0,
      totalMs: 0,
      usedTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    }
    group.count++
    if (session.durationMs !== null) {
      group.completed++
      group.totalMs += session.durationMs
    }
    group.usedTokens += session.usedTokens
    group.cachedTokens += session.cachedTokens
    group.costUsd += session.costUsd
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.usedTokens - a.usedTokens)
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-fg-faint">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export function SessionsView() {
  const { state } = useDashboard()
  const sessions = useMemo(() => sessionsFromEvents(state.events), [state.events])
  const running = sessions.filter((s) => s.endedAt === null).length
  const completed = sessions.filter((s) => s.durationMs !== null)
  const avgDuration =
    completed.length === 0
      ? null
      : completed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0) / completed.length
  const usedTokens = sessions.reduce((sum, s) => sum + s.usedTokens, 0)
  const cachedTokens = sessions.reduce((sum, s) => sum + s.cachedTokens, 0)
  const groups = groupByHarnessModel(sessions)
  const recent = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 50)

  return (
    <section>
      <div className="mb-4">
        <h1 className="text-xl font-semibold">Sessions</h1>
        <p className="text-sm text-fg-faint">
          Agent runs across the harness
          {running > 0 ? ` · ${running} in flight` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total sessions" value={String(sessions.length)} />
        <StatCard label="Avg session time" value={fmtDuration(avgDuration)} />
        <StatCard label="Tokens used" value={fmtTokens(usedTokens)} />
        <StatCard label="Tokens cached" value={fmtTokens(cachedTokens)} />
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
          By model + harness
        </h2>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-faint">
              <tr>
                <th className="px-4 py-2 font-medium">model</th>
                <th className="px-4 py-2 font-medium">harness</th>
                <th className="px-4 py-2 text-right font-medium">sessions</th>
                <th className="px-4 py-2 text-right font-medium">avg time</th>
                <th className="px-4 py-2 text-right font-medium">tokens used</th>
                <th className="px-4 py-2 text-right font-medium">tokens cached</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line bg-sunken">
              {groups.map((g) => (
                <tr key={`${g.harness}/${g.model}`}>
                  <td className="px-4 py-2 font-mono text-xs">{g.model}</td>
                  <td className="px-4 py-2">{g.harness}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{g.count}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmtDuration(g.completed === 0 ? null : g.totalMs / g.completed)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtTokens(g.usedTokens)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtTokens(g.cachedTokens)}</td>
                </tr>
              ))}
              {groups.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-fg-faint">
                    No sessions recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Recent sessions
        </h2>
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {recent.map((s) => (
            <li key={`${s.taskId}/${s.startedAt}`} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-fg-muted">{s.taskId}</span>
                <span className="block truncate text-sm font-medium">
                  {s.model ?? 'unknown'} · {s.harness} · {s.role}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                {fmtDuration(s.durationMs)}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                {fmtTokens(s.usedTokens)} used
              </span>
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                {fmtTokens(s.cachedTokens)} cached
              </span>
            </li>
          ))}
          {recent.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-fg-faint">
              No sessions recorded yet.
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}
