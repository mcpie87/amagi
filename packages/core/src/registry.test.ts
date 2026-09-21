import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRegistryEntry,
  findRegistryEntryByPath,
  isRepoRoot,
  loadRegistry,
  removeRegistryEntry,
  repoKey,
  sanitizeRepoKey,
} from './registry.ts'

let dir: string
let registry: string

function makeRepo(name: string): string {
  const path = join(dir, name)
  mkdirSync(path, { recursive: true })
  Bun.spawnSync(['git', 'init', '-q'], { cwd: path })
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-reg-'))
  registry = join(dir, 'registry.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeRepoKey', () => {
  test('lowercases, replaces non alphanumerics, trims separators', () => {
    expect(sanitizeRepoKey('My Repo!')).toBe('my-repo')
    expect(sanitizeRepoKey('--repo--')).toBe('repo')
    expect(sanitizeRepoKey('am-ote')).toBe('am-ote')
  })

  test('never returns an empty key', () => {
    expect(sanitizeRepoKey('!!!')).toBe('repo')
  })
})

describe('repoKey', () => {
  test('derives from the directory name', () => {
    expect(repoKey('/home/user/work/my-repo')).toBe('my-repo')
    expect(repoKey('/x/Some Repo')).toBe('some-repo')
  })
})

describe('addRegistryEntry', () => {
  test('registers a repo, resolving to the git root', () => {
    const repo = makeRepo('alpha')
    const sub = join(repo, 'src')
    mkdirSync(sub, { recursive: true })

    const entry = addRegistryEntry(sub, undefined, registry)
    expect(entry.path).toBe(repo)
    expect(entry.key).toBe('alpha')
    expect(entry.name).toBe('alpha')
    expect(loadRegistry(registry)).toHaveLength(1)
  })

  test('accepts a custom key', () => {
    const repo = makeRepo('alpha')
    expect(addRegistryEntry(repo, 'team-alpha', registry).key).toBe('team-alpha')
  })

  test('dedupes an already registered path', () => {
    const repo = makeRepo('alpha')
    addRegistryEntry(repo, undefined, registry)
    addRegistryEntry(repo, undefined, registry)
    expect(loadRegistry(registry)).toHaveLength(1)
  })

  test('makes keys unique on collision', () => {
    const a = makeRepo('alpha')
    const b = makeRepo('beta')
    addRegistryEntry(a, 'same', registry)
    const second = addRegistryEntry(b, 'same', registry)
    expect(second.key).toBe('same-2')
  })

  test('throws when the path is not inside a git repo', () => {
    const plain = join(dir, 'not-a-repo')
    mkdirSync(plain, { recursive: true })
    expect(() => addRegistryEntry(plain, undefined, registry)).toThrow(/not a git repository/)
  })
})

describe('removeRegistryEntry', () => {
  test('removes a known key and reports unknown ones', () => {
    const repo = makeRepo('alpha')
    addRegistryEntry(repo, undefined, registry)
    expect(removeRegistryEntry('alpha', registry)).toBe(true)
    expect(loadRegistry(registry)).toHaveLength(0)
    expect(removeRegistryEntry('alpha', registry)).toBe(false)
  })
})

describe('findRegistryEntryByPath', () => {
  test('matches on the resolved root', () => {
    const repo = makeRepo('alpha')
    const sub = join(repo, 'src')
    mkdirSync(sub, { recursive: true })
    addRegistryEntry(repo, undefined, registry)
    expect(findRegistryEntryByPath(sub, registry)?.key).toBe('alpha')
    expect(findRegistryEntryByPath('/unrelated', registry)).toBeNull()
  })
})

describe('isRepoRoot', () => {
  test('distinguishes git working trees', () => {
    const repo = makeRepo('alpha')
    const plain = join(dir, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(isRepoRoot(repo)).toBe(true)
    expect(isRepoRoot(plain)).toBe(false)
  })
})
