import { AgentRole } from '@amagi/core/events'
import { fmtDuration, fmtTokens } from '@amagi/core/format'
import { type SessionView, sessionsFromEvents } from '@amagi/core/sessions'
import { type ScorecardRow, scorecard } from '@amagi/core/view'
import { useMemo, useState } from 'react'
import { useDashboard } from './store.tsx'
import { Time } from './ui.tsx'

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

const DAY_MS = 86_400_000
const WINDOWS = [
  { label: '7d', ms: 7 * DAY_MS },
  { label: '30d', ms: 30 * DAY_MS },
  { label: 'all', ms: null },
] as const

function fmtUsd(row: ScorecardRow, usd: number): string {
  return row.costSeen ? `$${usd.toFixed(2)}` : '-'
}

function Scorecard() {
  const { state } = useDashboard()
  const [span, setSpan] = useState<(typeof WINDOWS)[number]['label']>('30d')
  const ms = WINDOWS.find((w) => w.label === span)?.ms ?? null
  const rows = useMemo(() => scorecard(state, ms === null ? 0 : Date.now() - ms), [state, ms])

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Outcomes by model + harness
        </h2>
        <fieldset className="flex gap-1.5">
          <legend className="sr-only">Scorecard window</legend>
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              aria-pressed={span === w.label}
              onClick={() => setSpan(w.label)}
              className={`rounded-full px-3 py-1 text-xs ring-1 ring-inset ${
                span === w.label
                  ? 'bg-sky-500/15 text-sky-700 ring-sky-500/40 dark:text-sky-300'
                  : 'bg-surface text-fg-muted ring-line hover:text-fg'
              }`}
            >
              {w.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-faint">
            <tr>
              <th className="px-4 py-2 font-medium">model</th>
              <th className="px-4 py-2 font-medium">harness</th>
              <th className="px-4 py-2 font-medium">workers</th>
              <th className="px-4 py-2 text-right font-medium">finished</th>
              <th className="px-4 py-2 text-right font-medium">merged</th>
              <th
                className="px-4 py-2 text-right font-medium"
                title="abandoned / no PR / needs human"
              >
                failed
              </th>
              <th className="px-4 py-2 text-right font-medium">cost / merge</th>
              <th className="px-4 py-2 text-right font-medium">time to merge</th>
              <th className="px-4 py-2 text-right font-medium">review rounds</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line bg-sunken">
            {rows.map((row) => (
              <tr key={`${row.harness}/${row.model}/${row.effort}`}>
                <td className="px-4 py-2 font-mono text-xs">
                  {row.model ?? 'unknown'}
                  {row.effort === null ? '' : ` · ${row.effort}`}
                </td>
                <td className="px-4 py-2">{row.harness}</td>
                <td className="px-4 py-2 text-xs text-fg-muted">
                  {row.workers.length === 0 ? 'ad hoc' : row.workers.join(', ')}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{row.finished}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.merged} ({Math.round((row.merged / row.finished) * 100)}%)
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.abandoned} / {row.noPr} / {row.needsHuman}
                </td>
                <td
                  className="px-4 py-2 text-right tabular-nums"
                  title={`total ${fmtUsd(row, row.costUsd)}`}
                >
                  {row.merged === 0 ? '-' : fmtUsd(row, row.costUsd / row.merged)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.medianMergeMs === null ? '-' : fmtDuration(row.medianMergeMs)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.avgReviewRounds.toFixed(1)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-fg-faint">
                  No finished tasks in this window.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function SessionsView() {
  const { state } = useDashboard()
  const [enabledRoles, setEnabledRoles] = useState<Set<(typeof AgentRole.options)[number]>>(
    () => new Set(AgentRole.options),
  )
  const sessions = useMemo(
    () => sessionsFromEvents(state.events).filter((s) => enabledRoles.has(s.role)),
    [state.events, enabledRoles],
  )
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

      <fieldset className="mb-4 flex flex-wrap gap-1.5">
        <legend className="sr-only">Filter sessions by agent role</legend>
        {AgentRole.options.map((role) => {
          const enabled = enabledRoles.has(role)
          return (
            <button
              key={role}
              type="button"
              aria-pressed={enabled}
              onClick={() => {
                setEnabledRoles((current) => {
                  const next = new Set(current)
                  if (next.has(role)) next.delete(role)
                  else next.add(role)
                  return next
                })
              }}
              className={`rounded-full px-3 py-1 text-xs ring-1 ring-inset ${
                enabled
                  ? 'bg-sky-500/15 text-sky-700 ring-sky-500/40 dark:text-sky-300'
                  : 'bg-surface text-fg-muted ring-line hover:text-fg'
              }`}
            >
              {role}
            </button>
          )
        })}
      </fieldset>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total sessions" value={String(sessions.length)} />
        <StatCard label="Avg session time" value={fmtDuration(avgDuration)} />
        <StatCard label="Tokens used" value={fmtTokens(usedTokens)} />
        <StatCard label="Tokens cached" value={fmtTokens(cachedTokens)} />
      </div>

      <Scorecard />

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
            <li
              key={`${s.watcherRunId ?? s.taskId ?? 'session'}/${s.startedAt}`}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <span className="shrink-0 text-xs tabular-nums text-fg-muted">
                <Time ts={s.startedAt} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-fg-muted">
                  {s.watcherSource ?? s.taskId}
                </span>
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
