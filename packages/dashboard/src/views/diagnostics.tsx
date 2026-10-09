import type { RequestSample, RouteTiming, TimingSnapshot } from '@amagi/core/request-timings'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { fmtAgo } from '../format.ts'
import { EmptyState, Time } from '../ui.tsx'

const POLL_MS = 3000

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`
}

function msTone(ms: number, warn: number, bad: number): string {
  if (ms >= bad) return 'text-red-ink'
  if (ms >= warn) return 'text-amber-ink'
  return ''
}

function statusTone(status: number): string {
  if (status >= 500) return 'text-red-ink'
  if (status >= 400) return 'text-amber-ink'
  return ''
}

type Filters = {
  request: string
  source: string
  /** `datetime-local` input values, local time. */
  from: string
  to: string
  minMs: string
  maxMs: string
}

const NO_FILTERS: Filters = { request: '', source: '', from: '', to: '', minMs: '', maxMs: '' }

function filterQuery(filters: Filters): string {
  const params = new URLSearchParams()
  for (const key of ['request', 'source'] as const) {
    const value = filters[key].trim()
    if (value !== '') params.set(key, value)
  }
  for (const key of ['from', 'to'] as const) {
    const ts = new Date(filters[key]).getTime()
    if (filters[key] !== '' && !Number.isNaN(ts)) params.set(key, String(ts))
  }
  for (const key of ['minMs', 'maxMs'] as const) {
    if (filters[key] !== '') params.set(key, filters[key])
  }
  return params.toString()
}

const inputClass =
  'rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent'

function useTimings(paused: boolean, query: string): TimingSnapshot | null | 'error' {
  const [snapshot, setSnapshot] = useState<TimingSnapshot | null | 'error'>(null)
  useEffect(() => {
    if (paused) return
    let active = true
    const refresh = () => {
      fetch(`${apiBase}/api/diagnostics/requests${query === '' ? '' : `?${query}`}`)
        .then((response) => (response.ok ? (response.json() as Promise<TimingSnapshot>) : null))
        .then((value) => {
          if (active) setSnapshot(value ?? 'error')
        })
        .catch(() => {
          if (active) setSnapshot('error')
        })
    }
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [paused, query])
  return snapshot
}

function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

function SampleTable({
  title,
  samples,
  onSelect,
}: {
  title: string
  samples: RequestSample[]
  onSelect: (sample: RequestSample) => void
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-fg-faint">
            <tr>
              <th className="px-4 py-2 font-medium">At</th>
              <th className="px-4 py-2 font-medium">Request</th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 text-right font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {samples.map((s) => (
              <tr key={s.id} onClick={() => onSelect(s)} className="cursor-pointer hover:bg-raised">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-fg-muted">
                  <Time ts={s.at} />
                </td>
                <td className="break-all px-4 py-2 font-mono text-xs">
                  <button type="button" onClick={() => onSelect(s)} className="text-left">
                    {s.method} {s.path}
                    {s.query !== '' && <span className="text-fg-faint">?{s.query}</span>}
                  </button>
                </td>
                <td className="break-all px-4 py-2 font-mono text-xs text-fg-muted">{s.source}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${statusTone(s.status)}`}>
                  {s.status}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${msTone(s.ms, 250, 1000)}`}>
                  {fmtMs(s.ms)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="mt-0.5 break-all text-fg">{children}</dd>
    </div>
  )
}

/**
 * Mount it only while open: it opens on mount, which puts it in the top layer
 * above any modal already open, so a request opened from the route modal
 * stacks on top and Esc closes just that one.
 */
function Modal({
  title,
  wide = false,
  onClose,
  children,
}: {
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialogRef.current?.showModal()
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
      className="watcher-dialog"
      style={wide ? { width: 'min(960px, calc(100vw - 32px))' } : undefined}
    >
      <div className="watcher-dialog-content p-4">
        <div className="break-all font-mono text-sm text-fg-strong">{title}</div>
        {children}
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
    </dialog>
  )
}

/**
 * Everything held for one request sample. `route` is looked up live from the
 * polled snapshot, so it reflects the current filters and may be missing once
 * the filters exclude the route.
 */
function RequestDetailDialog({
  sample,
  route,
  onClose,
}: {
  sample: RequestSample
  route: RouteTiming | null
  onClose: () => void
}) {
  const params = [...new URLSearchParams(sample.query)]
  return (
    <Modal title={`${sample.method} ${sample.path}`} onClose={onClose}>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Status">
          <span className={`tabular-nums ${statusTone(sample.status)}`}>{sample.status}</span>
        </Field>
        <Field label="Duration">
          <span className={`tabular-nums ${msTone(sample.ms, 250, 1000)}`}>{fmtMs(sample.ms)}</span>
        </Field>
        <Field label="Finished">
          <Time ts={sample.at} />
          <span className="ml-2 text-xs text-fg-faint">{fmtAgo(sample.at)}</span>
        </Field>
        <Field label="Route">
          <span className="font-mono text-xs">{sample.route}</span>
        </Field>
        <Field label="Source">
          <span className="font-mono text-xs">{sample.source}</span>
        </Field>
        <Field label="Request #">
          <span className="tabular-nums">{sample.id}</span>
        </Field>
      </dl>
      <dl className="mt-3 space-y-3 text-sm">
        {params.length > 0 && (
          <Field label="Query">
            <ul className="font-mono text-xs">
              {params.map(([key, value], index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: query keys may repeat; the index disambiguates.
                <li key={`${key}-${index}`}>
                  <span className="text-fg-muted">{key}</span>={value}
                </li>
              ))}
            </ul>
          </Field>
        )}
        <Field label="Referer">
          <span className="font-mono text-xs">{sample.referer ?? '-'}</span>
        </Field>
        <Field label="User agent">
          <span className="font-mono text-xs">{sample.userAgent ?? '-'}</span>
        </Field>
      </dl>
      <div className="mt-5 border-t border-line pt-4">
        <h3 className="text-xs uppercase tracking-wide text-fg-faint">Route, current filters</h3>
        {route === null ? (
          <p className="mt-2 text-xs text-fg-faint">no requests to this route in view</p>
        ) : (
          <>
            <dl className="mt-2 grid grid-cols-4 gap-x-4 gap-y-3 text-sm">
              <Field label="Calls">
                <span className="tabular-nums">{route.count}</span>
              </Field>
              <Field label="p50">
                <span className={`tabular-nums ${msTone(route.p50Ms, 250, 1000)}`}>
                  {fmtMs(route.p50Ms)}
                </span>
              </Field>
              <Field label="p95">
                <span className={`tabular-nums ${msTone(route.p95Ms, 250, 1000)}`}>
                  {fmtMs(route.p95Ms)}
                </span>
              </Field>
              <Field label="Max">
                <span className={`tabular-nums ${msTone(route.maxMs, 250, 1000)}`}>
                  {fmtMs(route.maxMs)}
                </span>
              </Field>
            </dl>
            {route.p50Ms > 0 && (
              <p className="mt-3 text-xs text-fg-muted">
                {(sample.ms / route.p50Ms).toFixed(1)}x the route median
                {route.errors > 0 && `, ${route.errors} of ${route.count} calls failed with 5xx`}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

type RouteKey = { method: string; route: string }

/** One route under the current filters, polled on its own while open. */
function RouteDetailDialog({
  selected,
  query,
  paused,
  onSelect,
  onClose,
}: {
  selected: RouteKey
  /** The page's filter query; the route is narrowed on top of it. */
  query: string
  paused: boolean
  onSelect: (sample: RequestSample) => void
  onClose: () => void
}) {
  const params = new URLSearchParams(query)
  params.set('method', selected.method)
  params.set('route', selected.route)
  const snapshot = useTimings(paused, params.toString())
  const timing = snapshot === null || snapshot === 'error' ? undefined : snapshot.routes[0]
  return (
    <Modal title={`${selected.method} ${selected.route}`} wide onClose={onClose}>
      {snapshot === 'error' ? (
        <p className="mt-4 text-sm text-red-ink">Could not load requests for this route.</p>
      ) : snapshot === null ? (
        <p className="mt-4 text-sm text-fg-faint">loading route requests...</p>
      ) : timing === undefined ? (
        <p className="mt-4 text-sm text-fg-faint">
          No requests to this route match the current filters.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-4 gap-x-6 gap-y-3 text-sm">
            <Field label="Calls">
              <span className="tabular-nums">{timing.count}</span>
            </Field>
            <Field label="5xx">
              <span
                className={`tabular-nums ${timing.errors > 0 ? 'text-red-ink' : 'text-fg-faint'}`}
              >
                {timing.errors}
              </span>
            </Field>
            <Field label="Avg">
              <span className={`tabular-nums ${msTone(timing.avgMs, 250, 1000)}`}>
                {fmtMs(timing.avgMs)}
              </span>
            </Field>
            <Field label="Total">
              <span className="tabular-nums">{fmtMs(timing.totalMs)}</span>
            </Field>
            <Field label="p50">
              <span className={`tabular-nums ${msTone(timing.p50Ms, 250, 1000)}`}>
                {fmtMs(timing.p50Ms)}
              </span>
            </Field>
            <Field label="p95">
              <span className={`tabular-nums ${msTone(timing.p95Ms, 250, 1000)}`}>
                {fmtMs(timing.p95Ms)}
              </span>
            </Field>
            <Field label="Max">
              <span className={`tabular-nums ${msTone(timing.maxMs, 250, 1000)}`}>
                {fmtMs(timing.maxMs)}
              </span>
            </Field>
            <Field label="Last call">
              <Time ts={timing.lastAt} />
            </Field>
          </dl>
          <section className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
              Callers
            </h2>
            <div className="overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs text-fg-faint">
                  <tr>
                    <th className="px-4 py-2 font-medium">Source</th>
                    <th className="px-4 py-2 text-right font-medium">Calls</th>
                    <th className="px-4 py-2 text-right font-medium">5xx</th>
                    <th className="px-4 py-2 text-right font-medium">Avg</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {snapshot.sources.map((s) => (
                    <tr key={s.source}>
                      <td className="break-all px-4 py-2 font-mono text-xs">{s.source}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{s.count}</td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums ${s.errors > 0 ? 'text-red-ink' : 'text-fg-faint'}`}
                      >
                        {s.errors}
                      </td>
                      <td
                        className={`px-4 py-2 text-right tabular-nums ${msTone(s.avgMs, 250, 1000)}`}
                      >
                        {fmtMs(s.avgMs)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtMs(s.totalMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <SampleTable title="Slowest requests" samples={snapshot.slowest} onSelect={onSelect} />
          <SampleTable title="Most recent requests" samples={snapshot.recent} onSelect={onSelect} />
        </>
      )}
    </Modal>
  )
}

export function DiagnosticsView() {
  const [paused, setPaused] = useState(false)
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [advanced, setAdvanced] = useState(false)
  const [selected, setSelected] = useState<RequestSample | null>(null)
  const [selectedRoute, setSelectedRoute] = useState<RouteKey | null>(null)
  const query = filterQuery(filters)
  const snapshot = useTimings(paused, query)
  const requestRoute =
    selected === null || snapshot === null || snapshot === 'error'
      ? null
      : (snapshot.routes.find((r) => r.method === selected.method && r.route === selected.route) ??
        null)
  const setFilter = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [key]: e.target.value }))

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Diagnostics</h1>
          <p className="text-sm text-fg-muted">
            API request timings, kept across server restarts until they age out. Stream routes
            measure time to first byte. Source is the dashboard page that was open, or the client's
            user agent for the TUI, CLI and other callers.
          </p>
        </div>
        <button
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
          className="rounded border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </header>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filters.request}
          onChange={setFilter('request')}
          placeholder="Search requests…"
          className={`w-60 ${inputClass}`}
        />
        <input
          type="search"
          value={filters.source}
          onChange={setFilter('source')}
          placeholder="Search sources…"
          className={`w-60 ${inputClass}`}
        />
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
          className="rounded border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
        >
          Advanced
        </button>
        {query !== '' && (
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="px-2 py-1.5 text-sm text-fg-muted hover:text-fg"
          >
            Clear
          </button>
        )}
        {query !== '' && typeof snapshot === 'object' && snapshot !== null && (
          <span className="text-sm text-fg-faint">
            {snapshot.matched} of {snapshot.total} requests
          </span>
        )}
      </div>
      {advanced && (
        <div className="mb-4 flex flex-wrap items-end gap-3 text-xs text-fg-faint">
          <label className="flex flex-col gap-1">
            From
            <input
              type="datetime-local"
              step="1"
              value={filters.from}
              onChange={setFilter('from')}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            To
            <input
              type="datetime-local"
              step="1"
              value={filters.to}
              onChange={setFilter('to')}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1">
            Min duration (ms)
            <input
              type="number"
              min={0}
              value={filters.minMs}
              onChange={setFilter('minMs')}
              className={`w-36 ${inputClass}`}
            />
          </label>
          <label className="flex flex-col gap-1">
            Max duration (ms)
            <input
              type="number"
              min={0}
              value={filters.maxMs}
              onChange={setFilter('maxMs')}
              className={`w-36 ${inputClass}`}
            />
          </label>
        </div>
      )}
      {snapshot === 'error' ? (
        <EmptyState title="Timings unavailable">Could not load request timings.</EmptyState>
      ) : snapshot === null ? (
        <p className="text-sm text-fg-faint">loading request timings...</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Event-loop lag"
              value={snapshot.eventLoop === null ? '-' : fmtMs(snapshot.eventLoop.lagMs)}
              tone={snapshot.eventLoop === null ? '' : msTone(snapshot.eventLoop.lagMs, 50, 250)}
            />
            <Stat
              label="Max lag, last minute"
              value={snapshot.eventLoop === null ? '-' : fmtMs(snapshot.eventLoop.maxLagMs)}
              tone={snapshot.eventLoop === null ? '' : msTone(snapshot.eventLoop.maxLagMs, 50, 250)}
            />
            <Stat
              label={`Requests held, ${Math.round(snapshot.retentionMs / 86_400_000)}d`}
              value={String(snapshot.total)}
            />
            <div className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-fg-faint">Window start</div>
              <div className="mt-1 text-sm text-fg">
                {snapshot.windowStart === null ? '-' : <Time ts={snapshot.windowStart} />}
              </div>
            </div>
          </div>
          {snapshot.matched === 0 ? (
            <div className="mt-6">
              {snapshot.total === 0 ? (
                <EmptyState title="No requests yet">
                  Timings appear once the dashboard calls the API.
                </EmptyState>
              ) : (
                <EmptyState title="No matching requests">
                  None of the {snapshot.total} held requests match the filters.
                </EmptyState>
              )}
            </div>
          ) : (
            <>
              {snapshot.analysed < snapshot.matched && (
                <p className="mt-4 text-sm text-fg-muted">
                  Tables cover the newest {snapshot.analysed} of {snapshot.matched} matching
                  requests. Narrow the time range under Advanced to look further back.
                </p>
              )}
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  By route, most total time first
                </h2>
                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full text-sm">
                    <thead className="border-b border-line text-left text-xs text-fg-faint">
                      <tr>
                        <th className="px-4 py-2 font-medium">Route</th>
                        <th className="px-4 py-2 text-right font-medium">Calls</th>
                        <th className="px-4 py-2 text-right font-medium">5xx</th>
                        <th className="px-4 py-2 text-right font-medium">Avg</th>
                        <th className="px-4 py-2 text-right font-medium">p50</th>
                        <th className="px-4 py-2 text-right font-medium">p95</th>
                        <th className="px-4 py-2 text-right font-medium">Max</th>
                        <th className="px-4 py-2 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {snapshot.routes.map((r) => (
                        <tr
                          key={`${r.method} ${r.route}`}
                          onClick={() => setSelectedRoute(r)}
                          className="cursor-pointer hover:bg-raised"
                        >
                          <td className="break-all px-4 py-2 font-mono text-xs">
                            <button
                              type="button"
                              onClick={() => setSelectedRoute(r)}
                              className="text-left"
                            >
                              {r.method} {r.route}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{r.count}</td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${r.errors > 0 ? 'text-red-ink' : 'text-fg-faint'}`}
                          >
                            {r.errors}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${msTone(r.avgMs, 250, 1000)}`}
                          >
                            {fmtMs(r.avgMs)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${msTone(r.p50Ms, 250, 1000)}`}
                          >
                            {fmtMs(r.p50Ms)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${msTone(r.p95Ms, 250, 1000)}`}
                          >
                            {fmtMs(r.p95Ms)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${msTone(r.maxMs, 250, 1000)}`}
                          >
                            {fmtMs(r.maxMs)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtMs(r.totalMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  By source, most total time first
                </h2>
                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full text-sm">
                    <thead className="border-b border-line text-left text-xs text-fg-faint">
                      <tr>
                        <th className="px-4 py-2 font-medium">Source</th>
                        <th className="px-4 py-2 text-right font-medium">Calls</th>
                        <th className="px-4 py-2 text-right font-medium">5xx</th>
                        <th className="px-4 py-2 text-right font-medium">Avg</th>
                        <th className="px-4 py-2 text-right font-medium">Total</th>
                        <th className="px-4 py-2 text-right font-medium">Last</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {snapshot.sources.map((s) => (
                        <tr key={s.source}>
                          <td className="break-all px-4 py-2 font-mono text-xs">{s.source}</td>
                          <td className="px-4 py-2 text-right tabular-nums">{s.count}</td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${s.errors > 0 ? 'text-red-ink' : 'text-fg-faint'}`}
                          >
                            {s.errors}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${msTone(s.avgMs, 250, 1000)}`}
                          >
                            {fmtMs(s.avgMs)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtMs(s.totalMs)}</td>
                          <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-fg-muted">
                            <Time ts={s.lastAt} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <SampleTable
                title="Slowest requests"
                samples={snapshot.slowest}
                onSelect={setSelected}
              />
              <SampleTable
                title="Most recent requests"
                samples={snapshot.recent}
                onSelect={setSelected}
              />
            </>
          )}
        </>
      )}
      {selectedRoute !== null && (
        <RouteDetailDialog
          selected={selectedRoute}
          query={query}
          paused={paused}
          onSelect={setSelected}
          onClose={() => setSelectedRoute(null)}
        />
      )}
      {selected !== null && (
        <RequestDetailDialog
          sample={selected}
          route={requestRoute}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
