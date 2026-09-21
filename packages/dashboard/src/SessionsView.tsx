import { type SessionView, sessionsFromEvents } from '@amagi/core/sessions'
import { useMemo } from 'react'
import { useDashboard } from './store.tsx'

function fmtTokens(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return 'in flight'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
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
        <p className="text-sm text-zinc-500">
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
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          By model + harness
        </h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">model</th>
                <th className="px-4 py-2 font-medium">harness</th>
                <th className="px-4 py-2 text-right font-medium">sessions</th>
                <th className="px-4 py-2 text-right font-medium">avg time</th>
                <th className="px-4 py-2 text-right font-medium">tokens used</th>
                <th className="px-4 py-2 text-right font-medium">tokens cached</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950">
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
                  <td colSpan={6} className="px-4 py-6 text-center text-zinc-500">
                    No sessions recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Recent sessions
        </h2>
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
          {recent.map((s) => (
            <li key={`${s.taskId}/${s.startedAt}`} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-zinc-400">{s.taskId}</span>
                <span className="block truncate text-sm font-medium">
                  {s.model ?? 'unknown'} · {s.harness} · {s.role}
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {fmtDuration(s.durationMs)}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {fmtTokens(s.usedTokens)} used
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">
                {fmtTokens(s.cachedTokens)} cached
              </span>
            </li>
          ))}
          {recent.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-zinc-500">
              No sessions recorded yet.
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}
