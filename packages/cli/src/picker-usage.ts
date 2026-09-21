import type { StoredEvent } from '@amagi/core'

/** Harness kind or model name -> number of times it was used in past runs. */
export type Usage = Record<string, number>

/** Counts harness/model usage from the run history recorded in the store. */
export function usageFromEvents(events: StoredEvent[]): Usage {
  const usage: Usage = {}
  for (const event of events) {
    if (event.type !== 'agent.started') continue
    usage[event.harness] = (usage[event.harness] ?? 0) + 1
    if (event.model !== null) usage[event.model] = (usage[event.model] ?? 0) + 1
  }
  return usage
}

/** Options sorted by pick frequency (most picked first), stable otherwise. */
export function byUsage<T extends { label: string }>(usage: Usage, options: readonly T[]): T[] {
  return [...options].sort((a, b) => (usage[b.label] ?? 0) - (usage[a.label] ?? 0))
}
