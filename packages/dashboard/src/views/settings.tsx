import { MAX_PARALLEL } from '@amagi/core/limits'
import { type FormEvent, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useDashboard } from '../store.tsx'
import { setThemePref, type ThemePref, useTheme, useThemePref } from '../theme.ts'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function Appearance() {
  const pref = useThemePref()
  const theme = useTheme()

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-1 text-sm text-fg-muted">Theme</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Stored in this browser only.
        {pref === 'system' ? ` System follows your OS appearance, currently ${theme}.` : ''}
      </p>
      <div className="inline-flex gap-1 rounded border border-line-strong p-1">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={pref === option.value}
            onClick={() => setThemePref(option.value)}
            className={`rounded px-3 py-1 text-sm ${
              pref === option.value
                ? 'bg-raised text-fg-strong'
                : 'text-fg-muted hover:bg-raised hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SettingsView() {
  const { selected } = useDashboard()
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (selected === null) return
    setLoaded(false)
    setMessage(null)
    fetch(`${apiBase}/api/repos/${selected}/settings`)
      .then((res) => (res.ok ? (res.json() as Promise<{ maxParallel: number }>) : null))
      .then((body) => {
        setLoaded(true)
        setValue(body === null ? '' : String(body.maxParallel))
      })
      .catch(() => setLoaded(true))
  }, [selected])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (selected === null || busy) return
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) {
      setMessage({
        kind: 'error',
        text: `workers must be an integer between 1 and ${MAX_PARALLEL}`,
      })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${selected}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxParallel: n }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setMessage({ kind: 'error', text: body?.error ?? `HTTP ${res.status}` })
        return
      }
      setMessage({ kind: 'ok', text: `saved: up to ${n} concurrent workers` })
    } catch {
      setMessage({ kind: 'error', text: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Appearance />
      {selected === null ? (
        <p className="mt-6 text-fg-faint">no repository selected</p>
      ) : (
        <form onSubmit={save} className="mt-6 rounded-lg border border-line bg-surface p-4">
          <label htmlFor="max-workers" className="mb-1 block text-sm text-fg-muted">
            Concurrent workers
          </label>
          <p className="mb-3 text-sm text-fg-faint">
            How many tasks run at once for {selected}. Applied live; in-flight runs are unaffected.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="max-workers"
              type="number"
              min={1}
              max={MAX_PARALLEL}
              step={1}
              value={value}
              disabled={!loaded}
              onChange={(e) => setValue(e.target.value)}
              className="w-28 rounded border border-line-strong bg-sunken px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy || !loaded}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {message !== null && (
            <p
              className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-emerald-ink' : 'text-red-ink'}`}
            >
              {message.text}
            </p>
          )}
        </form>
      )}
    </section>
  )
}
