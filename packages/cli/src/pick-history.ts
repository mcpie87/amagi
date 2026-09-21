import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateHome } from '@amagi/core'

/** Usage counts keyed by picker title + option label, persisted as JSON. */
type Counts = Record<string, number>

/** Where pick history lives; overridable per call so tests stay isolated. */
export function pickHistoryPath(): string {
  return join(stateHome(), 'amagi', 'pick-history.json')
}

const key = (title: string, label: string): string => `${title}\u0000${label}`

function load(path: string): Counts {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Counts
  } catch {
    return {}
  }
}

/**
 * Reorders options so the most-picked for this picker title come first; ties
 * keep the original fixed order. Corrupt or missing history reads as empty.
 */
export function orderOptions<T extends { label: string }>(
  title: string,
  options: readonly T[],
  path = pickHistoryPath(),
): T[] {
  const counts = load(path)
  return [...options].sort(
    (a, b) => (counts[key(title, b.label)] ?? 0) - (counts[key(title, a.label)] ?? 0),
  )
}

/** Bumps the pick count for this picker title + option label. */
export function recordPick(title: string, label: string, path = pickHistoryPath()): void {
  const counts = load(path)
  counts[key(title, label)] = (counts[key(title, label)] ?? 0) + 1
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(counts, null, 2))
}
