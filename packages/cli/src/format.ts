const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

export const dim = wrap('2')
export const bold = wrap('1')
export const red = wrap('31')
export const green = wrap('32')
export const yellow = wrap('33')
export const blue = wrap('34')
export const magenta = wrap('35')

/** Prints text indented two spaces, collapsed of leading/trailing blank lines. */
export function printBlock(text: string): void {
  for (const line of text.trim().split('\n')) console.log(`  ${line}`)
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
