import { tmpdir } from 'node:os'
import type { Config } from './config.ts'
import type { Tracker, TrackerTask } from './drivers/types.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { classifyDifficultyPrompt, classifyDifficultySystemPrompt } from './prompt.ts'

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

/**
 * The enforcement point: whether a worker running `model` may claim `task`.
 * Gating is off when the feature is disabled, the task has no difficulty, or
 * the level has no required tier mapped; otherwise the model's tier must reach
 * the task's bar.
 */
export function claimGate(config: Config, task: TrackerTask, model: string | null): ClaimGate {
  if (!config.difficulty.enabled) return { allowed: true }
  const difficulty = task.difficulty ?? null
  if (difficulty === null) return { allowed: true }
  const required = requiredTier(config, difficulty)
  if (tierRank(config, modelTier(config, model)) >= tierRank(config, required)) {
    return { allowed: true }
  }
  const name = model ?? 'configured model'
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
): Promise<TrackerTask | null> {
  if (!config.difficulty.enabled) return tracker.claim()
  const ready = await tracker.ready(20)
  for (const task of ready) {
    const gate = claimGate(config, task, model)
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
): Promise<string | null> {
  try {
    const harness = makeHarnessFn(config.harness.implement)
    const proc = harness.start({
      cwd: tmpdir(),
      prompt: classifyDifficultyPrompt({ title, description, levels: config.difficulty.levels }),
      systemPrompt: classifyDifficultySystemPrompt(),
      ...harnessStartOpts(config.harness.implement),
    })
    for await (const _ of proc.events()) {
      // drain the stream so the process completes
    }
    const outcome = await proc.done
    if (!outcome.ok) return null
    return parseDifficulty(outcome.summary ?? '', config.difficulty.levels)
  } catch {
    return null
  }
}
