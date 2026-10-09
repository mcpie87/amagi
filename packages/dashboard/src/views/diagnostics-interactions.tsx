import type {
  ActionTiming,
  InteractionSample,
  InteractionSnapshot,
} from '@amagi/core/interaction-timings'
import { useState } from 'react'
import { fmtAgo } from '../format.ts'
import { EmptyState, Time } from '../ui.tsx'
import {
  Field,
  fmtMs,
  inputClass,
  Modal,
  msTone,
  SortHeader,
  type SortState,
  type SortValue,
  Stat,
  sortedRows,
  toggleSort,
  usePolled,
} from './diagnostics-ui.tsx'

const paintTone = (ms: number | null) => (ms === null ? 'text-fg-faint' : msTone(ms, 200, 500))
const settledTone = (ms: number) => msTone(ms, 500, 2000)
const fmtPaint = (ms: number | null) => (ms === null ? '-' : fmtMs(ms))

const OUTCOME_TONE: Record<InteractionSample['outcome'], string> = {
  settled: 'text-fg-muted',
  superseded: 'text-fg-faint',
  timeout: 'text-red-ink',
}

function ActionLabel({ action, context }: { action: string; context: string | null }) {
  return (
    <>
      {action}
      {context !== null && <span className="text-fg-faint"> in {context}</span>}
    </>
  )
}

function sampleSortValue(sample: InteractionSample, column: string): SortValue {
  switch (column) {
    case 'at':
      return sample.at
    case 'action':
      return `${sample.action} ${sample.context ?? ''}`
    case 'page':
      return sample.path
    case 'paint':
      return sample.paintMs ?? -1
    case 'duration':
      return sample.ms
    case 'outcome':
      return sample.outcome
    case 'requests':
      return sample.requests.length
    default:
      return ''
  }
}

function actionSortValue(action: ActionTiming, column: string): SortValue {
  switch (column) {
    case 'action':
      return `${action.action} ${action.context ?? ''}`
    case 'page':
      return action.route
    case 'count':
      return action.count
    case 'unsettled':
      return action.unsettled
    case 'paint50':
      return action.p50PaintMs
    case 'paint95':
      return action.p95PaintMs
    case 'p50':
      return action.p50Ms
    case 'p95':
      return action.p95Ms
    case 'max':
      return action.maxMs
    case 'total':
      return action.totalMs
    default:
      return ''
  }
}

const right = 'px-4 py-2 text-right font-medium'

function SampleTable({
  title,
  samples,
  onSelect,
}: {
  title: string
  samples: InteractionSample[]
  onSelect: (sample: InteractionSample) => void
}) {
  const [sort, setSort] = useState<SortState | null>(null)
  const rows = sortedRows(samples, sort, sampleSortValue)
  const onSort = (column: string) => setSort((current) => toggleSort(current, column))
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-fg-faint">
            <tr>
              <SortHeader column="at" label="At" sort={sort} onSort={onSort} />
              <SortHeader column="action" label="Action" sort={sort} onSort={onSort} />
              <SortHeader column="page" label="Page" sort={sort} onSort={onSort} />
              <SortHeader
                column="paint"
                label="Paint"
                sort={sort}
                onSort={onSort}
                className={right}
              />
              <SortHeader
                column="duration"
                label="Duration"
                sort={sort}
                onSort={onSort}
                className={right}
              />
              <SortHeader column="outcome" label="Outcome" sort={sort} onSort={onSort} />
              <SortHeader
                column="requests"
                label="Requests"
                sort={sort}
                onSort={onSort}
                className={right}
              />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((s) => (
              <tr key={s.id} onClick={() => onSelect(s)} className="cursor-pointer hover:bg-raised">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-fg-muted">
                  <Time ts={s.at} />
                </td>
                <td className="break-all px-4 py-2 font-mono text-xs">
                  <button type="button" onClick={() => onSelect(s)} className="text-left">
                    <ActionLabel action={s.action} context={s.context} />
                  </button>
                </td>
                <td className="break-all px-4 py-2 font-mono text-xs text-fg-muted">{s.path}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${paintTone(s.paintMs)}`}>
                  {fmtPaint(s.paintMs)}
                </td>
                <td className={`px-4 py-2 text-right tabular-nums ${settledTone(s.ms)}`}>
                  {fmtMs(s.ms)}
                </td>
                <td className={`px-4 py-2 text-xs ${OUTCOME_TONE[s.outcome]}`}>{s.outcome}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.requests.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** One interaction with its requests laid out on a shared timeline. */
function InteractionDetailDialog({
  sample,
  onClose,
}: {
  sample: InteractionSample
  onClose: () => void
}) {
  const span = Math.max(
    sample.ms,
    ...sample.requests.map((r) => r.startMs + (r.ms ?? sample.ms - r.startMs)),
    1,
  )
  return (
    <Modal title={sample.action} wide onClose={onClose}>
      <dl className="mt-4 grid grid-cols-4 gap-x-6 gap-y-3 text-sm">
        <Field label="Paint">
          <span className={`tabular-nums ${paintTone(sample.paintMs)}`}>
            {fmtPaint(sample.paintMs)}
          </span>
        </Field>
        <Field label="Duration">
          <span className={`tabular-nums ${settledTone(sample.ms)}`}>{fmtMs(sample.ms)}</span>
        </Field>
        <Field label="Outcome">
          <span className={OUTCOME_TONE[sample.outcome]}>{sample.outcome}</span>
        </Field>
        <Field label="Kind">{sample.kind}</Field>
        <Field label="Started">
          <Time ts={sample.at} />
          <span className="ml-2 text-xs text-fg-faint">{fmtAgo(sample.at)}</span>
        </Field>
        <Field label="Page">
          <span className="font-mono text-xs">{sample.path}</span>
        </Field>
        <Field label="Route">
          <span className="font-mono text-xs">{sample.route}</span>
        </Field>
        <Field label="Dialog">{sample.context ?? '-'}</Field>
      </dl>
      <section className="mt-5 border-t border-line pt-4">
        <h3 className="text-xs uppercase tracking-wide text-fg-faint">
          Requests started while it was open
        </h3>
        {sample.requests.length === 0 ? (
          <p className="mt-2 text-xs text-fg-faint">none: the time is all rendering</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-fg-faint">
              <tr>
                <th className="py-1 pr-3 font-medium">Request</th>
                <th className="py-1 pr-3 text-right font-medium">Start</th>
                <th className="py-1 pr-3 text-right font-medium">Duration</th>
                <th className="py-1 pr-3 text-right font-medium">Status</th>
                <th className="w-1/3 py-1 font-medium">Timeline</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sample.requests.map((r, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same request may repeat; order is fixed.
                <tr key={index}>
                  <td className="break-all py-1 pr-3 font-mono text-xs">
                    {r.method} {r.path}
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums text-fg-muted">
                    +{fmtMs(r.startMs)}
                  </td>
                  <td
                    className={`py-1 pr-3 text-right tabular-nums ${r.ms === null ? 'text-fg-faint' : msTone(r.ms, 250, 1000)}`}
                  >
                    {r.ms === null ? 'unfinished' : fmtMs(r.ms)}
                  </td>
                  <td
                    className={`py-1 pr-3 text-right tabular-nums ${r.status === 0 || (r.status ?? 0) >= 400 ? 'text-red-ink' : ''}`}
                  >
                    {r.status === null ? '-' : r.status === 0 ? 'failed' : r.status}
                  </td>
                  <td className="py-1">
                    <div className="relative h-2 rounded bg-raised">
                      <div
                        className="absolute h-2 rounded bg-accent"
                        style={{
                          left: `${(r.startMs / span) * 100}%`,
                          width: `${Math.max(1, ((r.ms ?? span - r.startMs) / span) * 100)}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Modal>
  )
}

type Filters = { action: string; page: string; kind: string; minMs: string }

const NO_FILTERS: Filters = { action: '', page: '', kind: '', minMs: '' }

function filterQuery(filters: Filters): string {
  const params = new URLSearchParams()
  for (const key of ['action', 'page', 'kind', 'minMs'] as const) {
    const value = filters[key].trim()
    if (value !== '') params.set(key, value)
  }
  return params.toString()
}

export function InteractionsPanel({ paused }: { paused: boolean }) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [selected, setSelected] = useState<InteractionSample | null>(null)
  const [sort, setSort] = useState<SortState | null>(null)
  const query = filterQuery(filters)
  const snapshot = usePolled<InteractionSnapshot>(
    paused,
    `/api/diagnostics/interactions${query === '' ? '' : `?${query}`}`,
  )
  const actions =
    snapshot === null || snapshot === 'error'
      ? []
      : sortedRows(snapshot.actions, sort, actionSortValue)
  const onSort = (column: string) => setSort((current) => toggleSort(current, column))
  const setFilter = (key: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [key]: e.target.value }))

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={filters.action}
          onChange={setFilter('action')}
          placeholder="Search actions…"
          className={`w-60 ${inputClass}`}
        />
        <input
          type="search"
          value={filters.page}
          onChange={setFilter('page')}
          placeholder="Search pages…"
          className={`w-48 ${inputClass}`}
        />
        <select
          value={filters.kind}
          onChange={setFilter('kind')}
          aria-label="Kind"
          className={inputClass}
        >
          <option value="">all kinds</option>
          <option value="click">clicks</option>
          <option value="key">keys</option>
          <option value="change">picker changes</option>
          <option value="input">typing</option>
        </select>
        <input
          type="number"
          min={0}
          value={filters.minMs}
          onChange={setFilter('minMs')}
          placeholder="Min ms"
          className={`w-28 ${inputClass}`}
        />
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
            {snapshot.matched} of {snapshot.total} interactions
          </span>
        )}
      </div>
      {snapshot === 'error' ? (
        <EmptyState title="Timings unavailable">Could not load interaction timings.</EmptyState>
      ) : snapshot === null ? (
        <p className="text-sm text-fg-faint">loading interaction timings...</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              label="Paint p50"
              value={fmtMs(snapshot.p50PaintMs)}
              tone={paintTone(snapshot.p50PaintMs)}
            />
            <Stat
              label="Paint p95"
              value={fmtMs(snapshot.p95PaintMs)}
              tone={paintTone(snapshot.p95PaintMs)}
            />
            <Stat
              label="Settled p50"
              value={fmtMs(snapshot.p50Ms)}
              tone={settledTone(snapshot.p50Ms)}
            />
            <Stat
              label="Settled p95"
              value={fmtMs(snapshot.p95Ms)}
              tone={settledTone(snapshot.p95Ms)}
            />
            <Stat
              label={`Interactions held, ${Math.round(snapshot.retentionMs / 86_400_000)}d`}
              value={String(snapshot.total)}
            />
          </div>
          {snapshot.matched === 0 ? (
            <div className="mt-6">
              {snapshot.total === 0 ? (
                <EmptyState title="No interactions yet">
                  Interactions upload a few seconds after you click or type in the dashboard.
                </EmptyState>
              ) : (
                <EmptyState title="No matching interactions">
                  None of the {snapshot.total} held interactions match the filters.
                </EmptyState>
              )}
            </div>
          ) : (
            <>
              {snapshot.analysed < snapshot.matched && (
                <p className="mt-4 text-sm text-fg-muted">
                  Tables cover the newest {snapshot.analysed} of {snapshot.matched} matching
                  interactions.
                </p>
              )}
              <section className="mt-6">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  By action
                </h2>
                <div className="overflow-x-auto rounded-lg border border-line bg-surface">
                  <table className="w-full text-sm">
                    <thead className="border-b border-line text-left text-xs text-fg-faint">
                      <tr>
                        <SortHeader column="action" label="Action" sort={sort} onSort={onSort} />
                        <SortHeader column="page" label="Page" sort={sort} onSort={onSort} />
                        <SortHeader
                          column="count"
                          label="Count"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="unsettled"
                          label="Unsettled"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="paint50"
                          label="Paint p50"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="paint95"
                          label="Paint p95"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="p50"
                          label="p50"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="p95"
                          label="p95"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="max"
                          label="Max"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                        <SortHeader
                          column="total"
                          label="Total"
                          sort={sort}
                          onSort={onSort}
                          className={right}
                        />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {actions.map((a) => (
                        <tr key={JSON.stringify([a.kind, a.action, a.context, a.route])}>
                          <td className="break-all px-4 py-2 font-mono text-xs">
                            <ActionLabel action={a.action} context={a.context} />
                          </td>
                          <td className="break-all px-4 py-2 font-mono text-xs text-fg-muted">
                            {a.route}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{a.count}</td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${a.unsettled > 0 ? '' : 'text-fg-faint'}`}
                          >
                            {a.unsettled}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${paintTone(a.p50PaintMs)}`}
                          >
                            {fmtMs(a.p50PaintMs)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${paintTone(a.p95PaintMs)}`}
                          >
                            {fmtMs(a.p95PaintMs)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${settledTone(a.p50Ms)}`}
                          >
                            {fmtMs(a.p50Ms)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${settledTone(a.p95Ms)}`}
                          >
                            {fmtMs(a.p95Ms)}
                          </td>
                          <td
                            className={`px-4 py-2 text-right tabular-nums ${settledTone(a.maxMs)}`}
                          >
                            {fmtMs(a.maxMs)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums">{fmtMs(a.totalMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <SampleTable
                title="Slowest interactions"
                samples={snapshot.slowest}
                onSelect={setSelected}
              />
              <SampleTable
                title="Most recent interactions"
                samples={snapshot.recent}
                onSelect={setSelected}
              />
            </>
          )}
        </>
      )}
      {selected !== null && (
        <InteractionDetailDialog sample={selected} onClose={() => setSelected(null)} />
      )}
    </>
  )
}
