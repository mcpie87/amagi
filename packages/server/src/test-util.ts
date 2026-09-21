import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Config,
  openDatabase,
  Store,
  saveRegistry,
  type Tracker,
  Workspaces,
} from '@amagi/core'

export type TestWorkspaces = {
  workspaces: Workspaces
  stores: Record<string, Store>
  store: (key: string) => Store
  cleanup: () => void
}

export type TestWorkspacesOptions = {
  /** Injects a fake tracker into every workspace. */
  trackerFor?: (config: Config, path: string) => Tracker
}

/**
 * A Workspaces backed by a throwaway registry file and in-memory stores, so
 * server tests exercise the real repo resolution path without touching disk
 * state or real databases. Entry paths need not exist: workspace construction
 * only reads per-repo config, which defaults when absent.
 */
export function testWorkspaces(keys: string[], opts: TestWorkspacesOptions = {}): TestWorkspaces {
  const dir = mkdtempSync(join(tmpdir(), 'amagi-test-'))
  const registryFile = join(dir, 'registry.json')
  const stores: Record<string, Store> = {}
  saveRegistry(
    keys.map((key) => ({ key, name: key, path: join(dir, key) })),
    registryFile,
  )
  const workspaces = new Workspaces({
    registryPath: registryFile,
    storeFor: (key) => {
      stores[key] ??= new Store(openDatabase(':memory:'))
      return stores[key]
    },
    ...(opts.trackerFor === undefined ? {} : { trackerFor: opts.trackerFor }),
  })
  for (const key of keys) workspaces.get(key)
  return {
    workspaces,
    stores,
    store: (key: string) => {
      const s = stores[key]
      if (s === undefined) throw new Error(`no store for ${key}`)
      return s
    },
    cleanup: () => {
      for (const store of Object.values(stores)) store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
