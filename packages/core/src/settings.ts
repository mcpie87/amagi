/**
 * The config keys the dashboard edits through the generic settings route, with
 * where each one is written. Keys with their own routes (checks format/lint/test,
 * autoQueue, autoRebase, notify ntfy/desktopFailureAlerts, review enabled/maxRounds,
 * forge kind/remote, epicClose, workers, seats, profiles, watcher harnesses) are
 * not listed here.
 */

/** `repo`: the repository's `.amagi/config.toml`. `global`: the user config every repo inherits. */
export type SettingLayer = 'repo' | 'global'

export type EditableSetting = {
  /** Dotted path into Config. */
  path: string
  layer: SettingLayer
  /** Refused while the repo has a live run: a change would strand that run's worktree, branch or claim. */
  idleOnly?: true
  /** Read when the server builds the repo or starts its watchers, so a change applies after `amagi serve` restarts. */
  restart?: true
}

export const EDITABLE_SETTINGS = [
  { path: 'repo.baseBranch', layer: 'repo', idleOnly: true },
  { path: 'repo.worktreeRoot', layer: 'repo', idleOnly: true },
  { path: 'repo.setupCmd', layer: 'repo' },
  { path: 'repo.persona', layer: 'repo' },
  { path: 'tracker.kind', layer: 'repo', idleOnly: true, restart: true },
  { path: 'forge.agentHandle', layer: 'repo' },
  { path: 'checks.commands', layer: 'repo' },
  { path: 'checks.timeoutSec', layer: 'repo' },
  { path: 'review.harness', layer: 'repo' },
  { path: 'review.threshold', layer: 'repo' },
  { path: 'review.finalPass', layer: 'repo' },
  { path: 'review.maxTokens', layer: 'repo' },
  { path: 'review.lenses', layer: 'repo' },
  { path: 'loop.maxCheckRounds', layer: 'repo' },
  { path: 'loop.mentionWatchIntervalSec', layer: 'repo', restart: true },
  { path: 'loop.prCheckIntervalSec', layer: 'repo', restart: true },
  { path: 'loop.stallWatchIntervalSec', layer: 'repo', restart: true },
  { path: 'loop.epicCloseIntervalSec', layer: 'repo', restart: true },
  { path: 'loop.beadsGcIntervalSec', layer: 'repo', restart: true },
  { path: 'loop.conflictMaxIterations', layer: 'repo' },
  { path: 'loop.mergeTreeCheck', layer: 'repo' },
  { path: 'loop.stallTimeoutSec', layer: 'repo' },
  { path: 'loop.doomEnabled', layer: 'repo' },
  { path: 'loop.doomToolWindowSec', layer: 'repo' },
  { path: 'loop.doomToolRepeat', layer: 'repo' },
  { path: 'loop.doomCheckRounds', layer: 'repo' },
  { path: 'loop.doomDiffWindowSec', layer: 'repo' },
  { path: 'loop.questionTimeoutSec', layer: 'repo' },
  { path: 'loop.questionParkTimeoutSec', layer: 'repo' },
  { path: 'loop.maxRetries', layer: 'repo' },
  { path: 'loop.retryBaseMs', layer: 'repo' },
  { path: 'loop.retryMaxMs', layer: 'repo' },
  { path: 'loop.contextWarnTokens', layer: 'repo' },
  { path: 'loop.contextMaxTokens', layer: 'repo' },
  { path: 'loop.contextMaxRestarts', layer: 'repo' },
  { path: 'loop.contextOverrides', layer: 'repo' },
  { path: 'loop.autoQueueIdleSec', layer: 'repo' },
  { path: 'loop.maxRunMinutes', layer: 'repo' },
  { path: 'loop.maxCostUsd', layer: 'repo' },
  { path: 'notify.idle', layer: 'repo' },
  { path: 'notify.desktop', layer: 'repo' },
  { path: 'watchers.mention.allowedAuthors', layer: 'global' },
  { path: 'watchers.beadsGc.enabled', layer: 'global' },
  { path: 'difficulty.enabled', layer: 'global' },
  { path: 'difficulty.levels', layer: 'global' },
  { path: 'harness.implement', layer: 'global' },
  { path: 'harness.triage', layer: 'global' },
  { path: 'harness.definitions', layer: 'global' },
] as const satisfies readonly EditableSetting[]

export type EditableSettingPath = (typeof EDITABLE_SETTINGS)[number]['path']

/** Reads a dotted path out of a config object; undefined when any segment is missing. */
export function settingValue(config: object, path: string): unknown {
  let node: unknown = config
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** `{ a: { b: value } }` for path `a.b`: the shape writeConfig and writeGlobalConfig merge. */
export function settingPatch(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.')
  let patch: Record<string, unknown> = { [keys.pop() as string]: value }
  for (const key of keys.reverse()) patch = { [key]: patch }
  return patch
}
