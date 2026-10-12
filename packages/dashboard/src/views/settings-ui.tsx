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
const secondary =
  'rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised disabled:opacity-50'

export { card, secondary, send, Toggle }

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
