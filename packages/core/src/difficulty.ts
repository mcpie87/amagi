import { tmpdir } from 'node:os'
import type { Config } from './config.ts'
import type { AgentOutcome, Tracker, TrackerTask } from './drivers/types.ts'
import type { StoredEvent } from './events.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import type { ProjectedTask } from './project.ts'
import { classifyDifficultyPrompt, classifyDifficultySystemPrompt } from './prompt.ts'
import type { Store } from './store/store.ts'
import { recordWatcherAgentRun } from './watcher-agent.ts'

export type ClaimGate = { allowed: true } | { allowed: false; reason: string }

/** The model the implement harness would run, or null when unconfigured. */
export function implementModel(config: Config): string | null {
  return config.harness.implement.model ?? null
}

/** A model's tier, weakest tier for an unlisted model so gating fails closed on unknown models. */
export function modelTier(config: Config, model: string | null): string {
  const tiers = config.difficulty.tierOrder
  const listed = model !== null ? config.difficulty.modelTiers[model] : undefined
  return listed ?? tiers[0] ?? 'fast'
}

/** The minimum tier a difficulty level needs, weakest tier when unlisted so only mapped levels gate. */
export function requiredTier(config: Config, difficulty: string | null): string {
  const tiers = config.difficulty.tierOrder
  const listed = difficulty !== null ? config.difficulty.requiredTier[difficulty] : undefined
  return listed ?? tiers[0] ?? 'fast'
}

function tierRank(config: Config, tier: string): number {
  const index = config.difficulty.tierOrder.indexOf(tier)
  return index === -1 ? -1 : index
}

/** Merged and failed PRs per model and difficulty level; read it with `mergeRecord`. */
export type MergeRecords = Map<string, { merged: number; failed: number }>

const recordKey = (model: string | null, difficulty: string): string =>
  JSON.stringify([model, difficulty])

export function mergeRecord(
  records: MergeRecords,
  model: string | null,
  difficulty: string,
): { merged: number; failed: number } | undefined {
  return records.get(recordKey(model, difficulty))
}

/**
 * Each finished task's PR outcome, attributed like the scorecard to the first
 * implement agent of its current attempt and to the difficulty it was last
 * claimed at. A merge is a success; a closed PR, a hand-closed task or a
 * needs-human stop is a failure. Tasks that ended without a PR say nothing
 * about the model and are left out. `events` needs task.claimed, task.reset
 * and agent.started in seq order.
 */
export function mergeRecords(
  tasks: readonly ProjectedTask[],
  events: readonly StoredEvent[],
): MergeRecords {
  const attribution = new Map<string, { difficulty: string | null; model?: string | null }>()
  for (const event of events) {
    if (event.taskId === null) continue
    const entry = attribution.get(event.taskId) ?? { difficulty: null }
    if (event.type === 'task.claimed') {
      entry.difficulty = event.difficulty ?? null
    } else if (event.type === 'task.reset') {
      delete entry.model
    } else if (
      event.type === 'agent.started' &&
      event.role === 'implement' &&
      entry.model === undefined
    ) {
      entry.model = event.model
    }
    attribution.set(event.taskId, entry)
  }
  const records: MergeRecords = new Map()
  for (const task of tasks) {
    const merged = task.state === 'done' && task.prNumber !== null
    if (!merged && task.state !== 'abandoned' && task.state !== 'needs_human') continue
    const entry = attribution.get(task.id)
    if (entry?.model === undefined || entry.difficulty === null) continue
    const key = recordKey(entry.model, entry.difficulty)
    const record = records.get(key) ?? { merged: 0, failed: 0 }
    if (merged) record.merged++
    else record.failed++
    records.set(key, record)
  }
  return records
}

/** Merge records over the whole task history in `store`; empty when nothing would read them. */
export function storeMergeRecords(config: Config, store: Store): MergeRecords {
  if (!config.difficulty.enabled || config.difficulty.minSamples === 0) return new Map()
  return mergeRecords(
    store.tasks({ states: ['done', 'abandoned', 'needs_human'], limit: 1_000_000 }),
    store.eventsOfType(['task.claimed', 'task.reset', 'agent.started']),
  )
}

/**
 * The enforcement point: whether a worker running `model` may claim `task`.
 * Gating is off when the feature is disabled or the task has no difficulty.
 * Once `records` hold minSamples PR outcomes for the model at the task's
 * level, the model's merge rate there decides, in either direction; until
 * then the model's tier must reach the level's required tier, and a level
 * with no required tier mapped is not gated.
 */
export function claimGate(
  config: Config,
  task: TrackerTask,
  model: string | null,
  records?: MergeRecords,
): ClaimGate {
  if (!config.difficulty.enabled) return { allowed: true }
  const difficulty = task.difficulty ?? null
  if (difficulty === null) return { allowed: true }
  const name = model ?? 'configured model'
  const { minSamples, minMergeRate } = config.difficulty
  const record = records === undefined ? undefined : mergeRecord(records, model, difficulty)
  const outcomes = record === undefined ? 0 : record.merged + record.failed
  if (record !== undefined && minSamples > 0 && outcomes >= minSamples) {
    if (record.merged / outcomes >= minMergeRate) return { allowed: true }
    return {
      allowed: false,
      reason: `${name} merged ${record.merged} of ${outcomes} ${difficulty} difficulty PRs, below the ${Math.round(minMergeRate * 100)}% floor`,
    }
  }
  const required = requiredTier(config, difficulty)
  if (tierRank(config, modelTier(config, model)) >= tierRank(config, required)) {
    return { allowed: true }
  }
  const tier = modelTier(config, model)
  return {
    allowed: false,
    reason: `${name} is only a ${tier} model but ${difficulty} difficulty needs ${required}`,
  }
}

/**
 * Claims the next ready task a worker's model is allowed to take, skipping
 * (and reporting) the gated ones. Falls back to the tracker's own atomic
 * claim when gating is off, so the common path is unchanged. Claims by id so
 * a gated task is never taken and released in the same breath, which would
 * hand it straight back to a next `bd ready --claim` anyway.
 */
export async function claimEligible(
  tracker: Tracker,
  config: Config,
  model: string | null,
  onRejected?: (task: TrackerTask, reason: string) => void,
  records?: MergeRecords,
): Promise<TrackerTask | null> {
  if (!config.difficulty.enabled) return tracker.claim()
  const ready = await tracker.ready(20)
  for (const task of ready) {
    const gate = claimGate(config, task, model, records)
    if (gate.allowed) {
      const claimed = await tracker.claim(task.id)
      if (claimed !== null) return claimed
    } else if (onRejected) {
      onRejected(task, gate.reason)
    }
  }
  return null
}

/** The level whose name appears in the classifier's reply, or null. */
export function parseDifficulty(reply: string, levels: readonly string[]): string | null {
  const lower = reply.toLowerCase()
  for (const level of levels) {
    if (lower.includes(level.toLowerCase())) return level
  }
  return null
}

/**
 * Classifies a task by difficulty with an LLM pass over its title/description,
 * using the configured implement harness in a throwaway cwd. Best effort: any
 * harness failure yields null (no difficulty, so no gating) rather than
 * blocking task creation.
 */
export async function classifyDifficulty(
  title: string,
  description: string,
  config: Config,
  makeHarnessFn: typeof makeHarness = makeHarness,
  watcherSession?: { store?: Store; source: string },
): Promise<string | null> {
  try {
    const harness = makeHarnessFn(config.harness.implement)
    const proc = harness.start({
      cwd: tmpdir(),
      prompt: classifyDifficultyPrompt({ title, description, levels: config.difficulty.levels }),
      systemPrompt: classifyDifficultySystemPrompt(),
      ...harnessStartOpts(config.harness.implement),
    })
    let outcome: AgentOutcome
    if (watcherSession?.store !== undefined) {
      outcome = await recordWatcherAgentRun(proc, {
        store: watcherSession.store,
        role: 'triage',
        harness: harness.kind,
        source: watcherSession.source,
        cwd: tmpdir(),
      })
    } else {
      for await (const _ of proc.events()) {
        // Drain the stream so the process completes.
      }
      outcome = await proc.done
    }
    if (!outcome.ok) return null
    return parseDifficulty(outcome.summary ?? '', config.difficulty.levels)
  } catch {
    return null
  }
}
