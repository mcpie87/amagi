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
