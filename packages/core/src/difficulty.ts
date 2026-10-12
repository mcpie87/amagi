import { tmpdir } from 'node:os'
import type { Config } from './config.ts'
import type { AgentOutcome, Tracker, TrackerTask } from './drivers/types.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { classifyDifficultyPrompt, classifyDifficultySystemPrompt } from './prompt.ts'
import type { Store } from './store/store.ts'
import { recordWatcherAgentRun } from './watcher-agent.ts'

export type ClaimGate = { allowed: true } | { allowed: false; reason: string }

/** The worker a claim is made for; unset `difficulties` takes every level. */
export type ClaimWorker = { name: string; difficulties?: readonly string[] | undefined }

/**
 * The enforcement point: whether `worker` may claim `task`. Gating is off when
 * the feature is disabled, the task has no difficulty, or the worker takes
 * every level (including ad-hoc runs with no worker); otherwise the task's
 * level must be in the worker's list.
 */
export function claimGate(
  config: Config,
  task: TrackerTask,
  worker: ClaimWorker | null,
): ClaimGate {
  if (!config.difficulty.enabled || worker?.difficulties === undefined) return { allowed: true }
  const difficulty = task.difficulty ?? null
  if (difficulty === null || worker.difficulties.includes(difficulty)) return { allowed: true }
  return { allowed: false, reason: `${worker.name} does not take ${difficulty} difficulty tasks` }
}

/**
 * Claims the next ready task the worker takes, skipping
 * (and reporting) the gated ones. Falls back to the tracker's own atomic
 * claim when gating is off, so the common path is unchanged. Claims by id so
 * a gated task is never taken and released in the same breath, which would
 * hand it straight back to a next `bd ready --claim` anyway.
 */
export async function claimEligible(
  tracker: Tracker,
  config: Config,
  worker: ClaimWorker | null,
  onRejected?: (task: TrackerTask, reason: string) => void,
): Promise<TrackerTask | null> {
  if (!config.difficulty.enabled || worker?.difficulties === undefined) return tracker.claim()
  const ready = await tracker.ready(20)
  for (const task of ready) {
    const gate = claimGate(config, task, worker)
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
