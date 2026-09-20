const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

export const dim = wrap('2')
export const bold = wrap('1')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('34')
export const magenta = wrap('35')

export function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/** Pads on display width of the plain text, so ANSI codes do not skew columns. */
export function table(
  rows: string[][],
  colorize: (row: string[], i: number) => string[] = (r) => r,
): string {
  if (rows.length === 0) return ''
  const width = rows[0]?.length ?? 0
  const widths = Array.from({ length: width }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ?? '').length)),
  )
  return rows
    .map((row, i) => {
      const painted = colorize(row, i)
      return row
        .map((cell, c) => {
          const pad = ' '.repeat((widths[c] ?? 0) - cell.length)
          const text = painted[c] ?? cell
          return c === width - 1 ? text : text + pad
        })
        .join('  ')
        .trimEnd()
    })
    .join('\n')
}
