import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateHome } from '@amagi/core'

/** Option label -> number of times it was picked in the interactive run picker. */
export type Usage = Record<string, number>

const usageFile = (): string => join(stateHome(), 'amagi', 'picker-usage.json')

/** Reads recorded pick counts; a missing or corrupt file counts as none. */
export function loadUsage(): Usage {
  try {
    return JSON.parse(readFileSync(usageFile(), 'utf8')) as Usage
  } catch {
    return {}
  }
}

/** Persists the pick counts. */
export function saveUsage(usage: Usage): void {
  const path = usageFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(usage))
}

/** Options sorted by pick frequency (most picked first), stable otherwise. */
export function byUsage<T extends { label: string }>(usage: Usage, options: readonly T[]): T[] {
  return [...options].sort((a, b) => (usage[b.label] ?? 0) - (usage[a.label] ?? 0))
}
