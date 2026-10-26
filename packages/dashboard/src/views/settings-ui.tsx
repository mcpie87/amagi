import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'

async function send(method: string, path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.ok) return null
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null
    return parsed?.error ?? `HTTP ${res.status}`
  } catch {
    return 'could not reach the amagi server'
  }
}

const card = 'rounded-lg border border-line bg-surface p-4'
const input = 'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
const field = 'mb-1 block text-sm text-fg-muted'
const secondary =
  'rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised disabled:opacity-50'

export { card, field, input, ListEditor, secondary, send, Toggle }

function Toggle({
  on,
  label: text,
  title,
  disabled,
  onClick,
}: {
  on: boolean
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-50 ${
        on
          ? 'bg-emerald-ink text-on-solid hover:opacity-90'
          : 'border border-line-strong bg-surface text-fg-muted hover:bg-raised'
      }`}
    >
      {text}: {on ? 'on' : 'off'}
    </button>
  )
}

const clean = (rows: string[]) => rows.map((row) => row.trim()).filter((row) => row !== '')

/** Edits a list of strings one row at a time; blank rows are dropped on change. */
function ListEditor({
  label: text,
  items,
  placeholder,
  disabled,
  onChange,
}: {
  label: string
  items: string[]
  placeholder?: string
  disabled?: boolean
  onChange: (items: string[]) => void
}) {
  const [rows, setRows] = useState(items.length === 0 ? [''] : items)
  // Resync only on an outside change: echoing our own trimmed list back would eat a typed space.
  useEffect(() => {
    setRows((current) =>
      JSON.stringify(clean(current)) === JSON.stringify(items)
        ? current
        : items.length === 0
          ? ['']
          : items,
    )
  }, [items])
  const update = (next: string[]) => {
    setRows(next)
    onChange(clean(next))
  }
  return (
    <fieldset className="space-y-1" disabled={disabled}>
      <legend className={field}>{text}</legend>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and may repeat.
        <div key={index} className="flex gap-2">
          <input
            aria-label={`${text} ${index + 1}`}
            value={row}
            placeholder={placeholder}
            onChange={(event) => update(rows.map((r, i) => (i === index ? event.target.value : r)))}
            className={`${input} font-mono`}
          />
          <button
            type="button"
            aria-label={`Remove ${text} ${index + 1}`}
            onClick={() => update(rows.filter((_, i) => i !== index))}
            className={secondary}
          >
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setRows([...rows, ''])} className={secondary}>
        Add
      </button>
    </fieldset>
  )
}
