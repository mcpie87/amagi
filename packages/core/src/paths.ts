import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function xdg(envVar: string, fallback: string): string {
  const v = process.env[envVar]
  return v && isAbsolute(v) ? v : join(homedir(), fallback)
}

/**
 * Set by the dev shell's `amagi` wrapper so a from-source amagi keeps its own
 * stores, registry, shims and worktrees instead of sharing the installed
 * amagi's. Config is not moved: the fleet and git personas stay the operator's.
 */
function devHome(): string | undefined {
  const v = process.env.AMAGI_DEV_HOME
  return v && isAbsolute(v) ? v : undefined
}

export const configHome = (): string => xdg('XDG_CONFIG_HOME', '.config')
/** The operator's state home, ignoring AMAGI_DEV_HOME: for state every amagi must share. */
export const hostStateHome = (): string => xdg('XDG_STATE_HOME', '.local/state')
export const stateHome = (): string => {
  const dev = devHome()
  return dev ? join(dev, 'state') : hostStateHome()
}
export const cacheHome = (): string => {
  const dev = devHome()
  return dev ? join(dev, 'cache') : xdg('XDG_CACHE_HOME', '.cache')
}

export const globalConfigPath = (): string => join(configHome(), 'amagi', 'config.toml')
export const repoConfigPath = (repoRoot: string): string => join(repoRoot, '.amagi', 'config.toml')
export const userReviewPackPath = (): string => join(configHome(), 'amagi', 'review')
export const repoReviewPackPath = (repoRoot: string): string => join(repoRoot, '.amagi', 'review')

/**
 * One database per registered repository, so identical issue ids in different
 * repos never collide and every repo's store, tokens, logs and streams stay
 * scoped to it. `AMAGI_DB` overrides to a single file for tests that want one.
 */
export function dbPathForRepo(key: string): string {
  const override = process.env.AMAGI_DB
  if (override) return resolve(expandTilde(override))
  return join(stateHome(), 'amagi', 'repos', `${key}.db`)
}

/** API request timings shown on the dashboard's Diagnostics page; one file for the whole server. */
export const requestTimingsPath = (): string => join(stateHome(), 'amagi', 'request-timings.db')

/** The repository registry lives here; overridable for tests. */
export function registryPath(): string {
  const override = process.env.AMAGI_REGISTRY
  if (override) return resolve(expandTilde(override))
  return join(stateHome(), 'amagi', 'registry.json')
}

/**
 * Per-run scratch dir under the state home. The git shim appends rejected
 * agent calls to `rejected-git.jsonl` here; the channel task drains that into
 * task events.
 */
export function runStateDir(taskId: string): string {
  return join(stateHome(), 'amagi', 'runs', taskId)
}

/** The git shim's rejected-call log for one task's run, drained by the runner. */
export function rejectedGitLogPath(taskId: string): string {
  return join(runStateDir(taskId), 'rejected-git.jsonl')
}
