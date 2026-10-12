import { type ReactNode, useEffect, useRef, useState } from 'react'
import { apiBase } from '../api.ts'

const POLL_MS = 3000

/** Polls a diagnostics snapshot; null until the first answer, 'error' when it failed. */
export function usePolled<T>(paused: boolean, path: string): T | null | 'error' {
  const [snapshot, setSnapshot] = useState<T | null | 'error'>(null)
  useEffect(() => {
    if (paused) return
    let active = true
    const refresh = () => {
      fetch(`${apiBase}${path}`)
        .then((response) => (response.ok ? (response.json() as Promise<T>) : null))
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
  }, [paused, path])
  return snapshot
}

export type SortState = { column: string; direction: 'asc' | 'desc' }
export type SortValue = number | string

export function sortedRows<T>(
  rows: readonly T[],
  sort: SortState | null,
  value: (row: T, column: string) => SortValue,
): T[] {
  if (sort === null) return [...rows]
  const direction = sort.direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = value(a, sort.column)
    const right = value(b, sort.column)
    const comparison =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: 'base',
          })
    return comparison * direction
  })
}

export function toggleSort(sort: SortState | null, column: string): SortState {
  return {
    column,
    direction: sort?.column === column && sort.direction === 'asc' ? 'desc' : 'asc',
  }
}

export function SortHeader({
  column,
  label,
  sort,
  onSort,
  className = 'px-4 py-2 font-medium',
}: {
  column: string
  label: string
  sort: SortState | null
  onSort: (column: string) => void
  className?: string
}) {
  return (
    <th
      className={className}
      aria-sort={
        sort?.column === column ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex cursor-pointer items-center gap-1 font-medium hover:text-fg-strong"
      >
        {label}
        <span aria-hidden="true" className="text-[10px]">
          {sort?.column === column ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  )
}

export function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`
}

export function msTone(ms: number, warn: number, bad: number): string {
  if (ms >= bad) return 'text-red-ink'
  if (ms >= warn) return 'text-amber-ink'
  return ''
}

export const inputClass =
  'rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent'

export function Stat({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
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
export function Modal({
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
