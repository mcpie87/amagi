import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { registryPath } from './paths.ts'

export type RegistryEntry = {
  /** URL-safe unique key; scopes store, stream and run actions. */
  key: string
  /** Human readable label, the repo directory name by default. */
  name: string
  /** Absolute path of the repo root. */
  path: string
}

/** Keeps keys safe as URL segments and file names. */
export function sanitizeRepoKey(key: string): string {
  const cleaned = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'repo'
}

/** Default key for a repo path: the repo directory name, sanitized. */
export function repoKey(path: string): string {
  return sanitizeRepoKey(basename(resolve(path)))
}

export function loadRegistry(path = registryPath()): RegistryEntry[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is RegistryEntry =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as RegistryEntry).key === 'string' &&
            typeof (e as RegistryEntry).path === 'string',
        )
      : []
  } catch {
    return []
  }
}

export function saveRegistry(entries: RegistryEntry[], path = registryPath()): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`)
}

/** True when the path resolves to a git working tree root. */
export function isRepoRoot(path: string): boolean {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: path,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}

export function findRegistryEntryByPath(
  path: string,
  registry = registryPath(),
): RegistryEntry | null {
  const root = gitRoot(path) ?? resolve(path)
  return loadRegistry(registry).find((e) => resolve(e.path) === root) ?? null
}

/** Git working tree root for a path, or null when it is not inside a repo. */
export function gitRoot(path: string): string | null {
  if (!isRepoRoot(path)) return null
  const out = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: path,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const root = out.stdout.toString().trim()
  return root.length > 0 ? resolve(root) : null
}

function uniqueKey(base: string, existing: RegistryEntry[]): string {
  const key = sanitizeRepoKey(base)
  if (!existing.some((e) => e.key === key)) return key
  for (let i = 2; ; i++) {
    const candidate = `${key}-${i}`
    if (!existing.some((e) => e.key === candidate)) return candidate
  }
}

/**
 * Registers a repo by path. The path may be any directory inside the repo;
 * the stored path is the git root so per-repo config resolves regardless of
 * where the operator stood. Throws when the path is not inside a git repo.
 */
export function addRegistryEntry(
  path: string,
  key?: string,
  registry = registryPath(),
): RegistryEntry {
  const root = gitRoot(path)
  if (root === null) throw new Error(`not a git repository: ${path}`)
  const entries = loadRegistry(registry).filter((e) => resolve(e.path) !== root)
  const entry: RegistryEntry = {
    key: uniqueKey(key ?? repoKey(root), entries),
    name: basename(root),
    path: root,
  }
  saveRegistry([...entries, entry], registry)
  return entry
}

export function removeRegistryEntry(key: string, registry = registryPath()): boolean {
  const entries = loadRegistry(registry)
  const kept = entries.filter((e) => e.key !== key)
  if (kept.length === entries.length) return false
  saveRegistry(kept, registry)
  return true
}
