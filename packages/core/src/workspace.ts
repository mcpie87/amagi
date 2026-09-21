import { type Config, loadConfig } from './config.ts'
import { diagnoseRepo } from './diagnose.ts'
import { makePrDriver, type PrDriver } from './drivers/pr.ts'
import type { BeadsIssue } from './drivers/tracker/beads.ts'
import type { Tracker } from './drivers/types.ts'
import { makeTracker } from './factory.ts'
import { dbPathForRepo, registryPath as defaultRegistryPath } from './paths.ts'
import {
  addRegistryEntry,
  loadRegistry,
  type RegistryEntry,
  removeRegistryEntry,
} from './registry.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

/**
 * One repo's full orchestration context: its config, per-repo store, tracker
 * and forge, all built from the repo's own `.amagi/config.toml` (merged with
 * the global config). Task ids stay raw inside the store; the workspace key
 * scopes them across repos.
 */
export type Workspace = {
  key: string
  name: string
  root: string
  config: Config
  store: Store
  tracker: Tracker
  /** Null when the configured forge driver is not implemented yet (forgejo). */
  forge: PrDriver | null
  listIssues?: () => Promise<BeadsIssue[]>
  /** Rich issue detail, including dependency blockers, when the tracker has it. */
  getIssue?: (id: string) => Promise<BeadsIssue | null>
}

export type WorkspacesOptions = {
  registryPath?: string
  /** Overridable so tests use in-memory databases. */
  storeFor?: (key: string) => Store
  /** Overridable so tests can inject a fake tracker. */
  trackerFor?: (config: Config, path: string) => Tracker
}

/**
 * Resolves registered repos into workspaces on demand and caches them. The
 * registry file is re-read on every access, so `amagi add` and the server's
 * onboard endpoint take effect without a restart.
 */
export class Workspaces {
  private readonly cache = new Map<string, Workspace>()

  constructor(private readonly opts: WorkspacesOptions = {}) {}

  private path(): string {
    return this.opts.registryPath ?? defaultRegistryPath()
  }

  list(): RegistryEntry[] {
    return loadRegistry(this.path())
  }

  get(key: string): Workspace | null {
    const cached = this.cache.get(key)
    if (cached) return cached
    const entry = this.list().find((e) => e.key === key)
    if (!entry) return null
    const workspace = this.build(entry)
    this.cache.set(key, workspace)
    return workspace
  }

  private build(entry: RegistryEntry): Workspace {
    const { config } = loadConfig(entry.path)
    const store = (this.opts.storeFor ?? defaultStoreFor)(entry.key)
    const tracker = (this.opts.trackerFor ?? makeTracker)(config, entry.path)
    let forge: PrDriver | null
    try {
      forge = makePrDriver(config.forge.kind)
    } catch (err) {
      console.warn(
        `workspace ${entry.key}: forge driver ${config.forge.kind} unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      forge = null
    }
    // The issue browser is a duck-typed capability: the beads tracker (and
    // fakes that mimic it) expose list/getIssue, other trackers leave the
    // workspace without them so the API answers 501 for that repo.
    const hasIssueBrowser = (
      t: Tracker,
    ): t is Tracker & {
      list(limit?: number): Promise<BeadsIssue[]>
      getIssue(id: string): Promise<BeadsIssue | null>
    } =>
      typeof (t as { list?: unknown }).list === 'function' &&
      typeof (t as { getIssue?: unknown }).getIssue === 'function'
    const listIssues = hasIssueBrowser(tracker) ? () => tracker.list() : undefined
    const getIssue = hasIssueBrowser(tracker) ? (id: string) => tracker.getIssue(id) : undefined
    return {
      key: entry.key,
      name: entry.name,
      root: entry.path,
      config,
      store,
      tracker,
      forge,
      ...(listIssues === undefined ? {} : { listIssues }),
      ...(getIssue === undefined ? {} : { getIssue }),
    }
  }

  /** Registers a repo and returns its entry. Throws when path is not a repo. */
  add(path: string, key?: string): RegistryEntry {
    return addRegistryEntry(path, key, this.opts.registryPath)
  }

  remove(key: string): boolean {
    const removed = removeRegistryEntry(key, this.opts.registryPath)
    this.cache.delete(key)
    return removed
  }

  /** Readiness diagnostics for one registered repo. */
  diagnose(entry: RegistryEntry) {
    return diagnoseRepo(entry)
  }

  close(): void {
    for (const ws of this.cache.values()) ws.store.close()
    this.cache.clear()
  }
}

const defaultStoreFor = (key: string): Store => new Store(openDatabase(dbPathForRepo(key)))
