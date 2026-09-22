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

export const configHome = (): string => xdg('XDG_CONFIG_HOME', '.config')
export const stateHome = (): string => xdg('XDG_STATE_HOME', '.local/state')
export const cacheHome = (): string => xdg('XDG_CACHE_HOME', '.cache')

export const globalConfigPath = (): string => join(configHome(), 'amagi', 'config.toml')
export const repoConfigPath = (repoRoot: string): string => join(repoRoot, '.amagi', 'config.toml')

/** Overridable so tests and parallel runs do not share one database. */
export function dbPath(): string {
  const override = process.env.AMAGI_DB
  if (override) return resolve(expandTilde(override))
  return join(stateHome(), 'amagi', 'amagi.db')
}

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
