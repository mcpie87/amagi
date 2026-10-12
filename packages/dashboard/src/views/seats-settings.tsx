import { MAX_HARNESS_PROCESSES } from '@amagi/core/limits'
import { useCallback, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { card, secondary, send } from './settings-ui.tsx'

export type SeatName = { name: string; count: number }
type SeatDraft = { original: string | null; name: string; count: number }

export function SeatsSettings({ onSaved }: { onSaved: () => void }) {
  const [entries, setEntries] = useState<SeatDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    fetch(`${apiBase}/api/seat-names`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { seats: SeatName[] }
        setEntries(body.seats.map(({ name, count }) => ({ original: name, name, count })))
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'could not reach the amagi server'),
      )
  }, [])

  useEffect(() => refresh(), [refresh])

  const names = entries?.map(({ name }) => name.trim()).filter(Boolean) ?? []
  const valid =
    entries?.every(
      ({ name, count }) =>
        name.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 16,
    ) && new Set(names).size === names.length

  const save = async () => {
    if (entries === null || !valid) return
    setBusy(true)
    setError(null)
    const seats = entries.map(({ name, count }) => ({ name: name.trim(), count }))
    const renames = entries.flatMap(({ original, name }) =>
      original !== null && original !== name.trim() ? [{ from: original, to: name.trim() }] : [],
    )
    const err = await send('PUT', '/api/seat-names', { seats, renames })
    setBusy(false)
    if (err !== null) setError(err)
    else {
      onSaved()
      refresh()
    }
  }

  return (
    <div className={`mt-6 ${card}`}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm text-fg-muted">Seats</h2>
        <button
          type="button"
          onClick={() => setEntries([...(entries ?? []), { original: null, name: '', count: 1 }])}
          disabled={entries === null || busy}
          className={secondary}
        >
          Add seat
        </button>
      </div>
      <p className="mb-3 text-sm text-fg-faint">
        Rename a seat to update every worker, watcher, and harness that uses it. Removing a seat
        resets its references to the default seat.
      </p>
      {entries === null ? (
        <p className="text-sm text-fg-faint">Loading seats...</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, index) => (
            <div key={entry.original ?? `new-${index}`} className="flex gap-2">
              <input
                aria-label={`Seat ${index + 1}`}
                value={entry.name}
                onChange={(event) =>
                  setEntries(
                    entries.map((seat, i) =>
                      i === index ? { ...seat, name: event.target.value } : seat,
                    ),
                  )
                }
                className="w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong"
              />
              <label className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
                Slots
                <input
                  aria-label={`Seat ${index + 1} slots`}
                  type="number"
                  min={1}
                  max={16}
                  value={entry.count}
                  onChange={(event) =>
                    setEntries(
                      entries.map((seat, i) =>
                        i === index ? { ...seat, count: Number(event.target.value) } : seat,
                      ),
                    )
                  }
                  className="w-20 rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong"
                />
              </label>
              <button
                type="button"
                onClick={() => setEntries(entries.filter((_, i) => i !== index))}
                disabled={busy}
                className={secondary}
              >
                Remove
              </button>
            </div>
          ))}
          {entries.length === 0 && <p className="text-sm text-fg-faint">No named seats.</p>}
        </div>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || busy}
          className={secondary}
        >
          {busy ? 'Saving...' : 'Save seats'}
        </button>
        {entries !== null && !valid && (
          <span className="text-sm text-amber-ink">Seat names must be unique and non-empty.</span>
        )}
      </div>
    </div>
  )
}

export function ProcessCapSettings() {
  const [saved, setSaved] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${apiBase}/api/harness-process-cap`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { maxProcesses: number }
        setSaved(body.maxProcesses)
        setDraft(String(body.maxProcesses))
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'could not reach the amagi server'),
      )
  }, [])

  const value = Number(draft)
  const valid = Number.isInteger(value) && value >= 1 && value <= MAX_HARNESS_PROCESSES

  const save = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    const err = await send('PUT', '/api/harness-process-cap', { maxProcesses: value })
    setBusy(false)
    if (err !== null) setError(err)
    else setSaved(value)
  }

  return (
    <div className={`mt-6 ${card}`}>
      <h2 className="mb-2 text-sm text-fg-muted">Harness process cap</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Most agent processes running at once on this host: workers, watchers and chats. A launch
        past the cap waits for one to exit. Chats wait only on this cap, never on seats.
      </p>
      <div className="flex items-center gap-2">
        <input
          aria-label="Harness process cap"
          type="number"
          min={1}
          max={MAX_HARNESS_PROCESSES}
          value={draft}
          disabled={saved === null || busy}
          onChange={(event) => setDraft(event.target.value)}
          className="w-24 rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || busy || value === saved}
          className={secondary}
        >
          {busy ? 'Saving...' : 'Save cap'}
        </button>
        {saved !== null && !valid && (
          <span className="text-sm text-amber-ink">
            Enter a whole number from 1 to {MAX_HARNESS_PROCESSES}.
          </span>
        )}
      </div>
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
    </div>
  )
}
