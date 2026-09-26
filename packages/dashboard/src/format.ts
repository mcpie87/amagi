export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD hh:mm:ss'

const DATE_TOKENS = /YYYY|MM|DD|hh|mm|ss/g

export function normalizeDateFormat(format: string): string {
  const candidate = format.trim()
  if (candidate === '' || /[A-Za-z]/.test(candidate.replace(DATE_TOKENS, ''))) {
    return DEFAULT_DATE_FORMAT
  }
  return candidate
}

export function fmtDateTime(value: Date | number, format = DEFAULT_DATE_FORMAT): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()).padStart(4, '0'),
    MM: String(date.getMonth() + 1).padStart(2, '0'),
    DD: String(date.getDate()).padStart(2, '0'),
    hh: String(date.getHours()).padStart(2, '0'),
    mm: String(date.getMinutes()).padStart(2, '0'),
    ss: String(date.getSeconds()).padStart(2, '0'),
  }
  return normalizeDateFormat(format).replace(DATE_TOKENS, (token) => tokens[token] ?? token)
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

export function fmtCpu(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Compact fixed-width elapsed time, e.g. 0:42, 12:07, 2:41:33. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** Compact "x ago" for a worker's last-run stamp; empty before the first tick. */
export function fmtLastRun(epochMs: number): string {
  if (epochMs <= 0) return 'never'
  const s = Math.floor((Date.now() - epochMs) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

/** Compact "in x" for a worker's next scheduled tick. */
export function fmtUntil(epochMs: number): string {
  const s = Math.floor((epochMs - Date.now()) / 1000)
  if (s <= 0) return 'due now'
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m`
  return `in ${Math.floor(m / 60)}h`
}

/** Human tick cadence, e.g. 5m for the default watcher interval. */
export function fmtInterval(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** How long until a scheduled retry fires, e.g. "in 45s". */
export function fmtRetryIn(ts: number): string {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (s <= 0) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
