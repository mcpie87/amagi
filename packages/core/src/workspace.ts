import { BeadsService } from './beads-service.ts'
import { type Config, loadConfig } from './config.ts'
import { diagnoseRepo } from './diagnose.ts'
import { makePrDriver, type PrDriver } from './drivers/pr.ts'
import { type PrForge, prForgeRouter } from './drivers/pr-route.ts'
import { BeadsTracker } from './drivers/tracker/beads.ts'
import type { Tracker } from './drivers/types.ts'
import { makeTracker } from './factory.ts'
import { dbPathForRepo, registryPath as defaultRegistryPath } from './paths.ts'
import {
  addRegistryEntry,
  type GitIdentity,
  loadRegistry,
  type RegistryEntry,
  type RegistryParticipation,
  removeRegistryEntry,
  updateRegistryGitIdentity,
  updateRegistryParticipation,
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
  /** Cached reads over `tracker` when it is beads; null for other trackers. */
  beads: BeadsService | null
  /** Follows `config.forge.kind` live; null only when a test injects no forge. */
  forge: PrDriver | null
  /** Routes a PR URL to the forge it lives on, falling back to `forge`; null when `forge` is. */
  prForge: ((prUrl: string | null) => PrForge) | null
}

export type WorkspacesOptions = {
  registryPath?: string
  /** Overridable so tests use in-memory databases. */
  storeFor?: (key: string) => Store
  /** Overridable so tests can inject a fake tracker. */
  trackerFor?: ((config: Config, path: string) => Tracker) | undefined
  /** Overridable so tests can inject a fake forge driver. */
  forgeFor?: (config: Config, path: string) => PrDriver | null
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

  /** Refresh watcher switches from disk so the server supervisor can apply edits live. */
  refreshWatcherConfig(key: string): Workspace | null {
    const workspace = this.get(key)
    if (workspace === null) return null
    const entry = this.list().find((candidate) => candidate.key === key)
    if (entry === undefined) return null
    workspace.config.watchers = loadConfig(entry.path).config.watchers
    return workspace
  }

  private build(entry: RegistryEntry): Workspace {
    const { config } = loadConfig(entry.path)
    const store = (this.opts.storeFor ?? defaultStoreFor)(entry.key)
    const tracker = (this.opts.trackerFor ?? makeTracker)(config, entry.path)
    const forge =
      this.opts.forgeFor !== undefined ? this.opts.forgeFor(config, entry.path) : liveForge(config)
    return {
      key: entry.key,
      name: entry.name,
      root: entry.path,
      config,
      store,
      tracker,
      beads: tracker instanceof BeadsTracker ? new BeadsService(tracker, entry.path) : null,
      forge,
      prForge: forge === null ? null : prForgeRouter(entry.path, config, forge),
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

  /** Updates per-repository server participation flags in the global registry. */
  updateParticipation(key: string, participation: RegistryParticipation): boolean {
    return updateRegistryParticipation(key, participation, this.opts.registryPath)
  }

  updateGitIdentity(key: string, gitIdentity: GitIdentity | null): boolean {
    return updateRegistryGitIdentity(key, gitIdentity, this.opts.registryPath)
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

/**
 * Forge driver that follows `config.forge.kind` on every call, so switching
 * the forge in the repository settings reaches the pollers, watchers and
 * runners already holding the workspace's driver.
 */
function liveForge(config: Config): PrDriver {
  const drivers = new Map<string, PrDriver>()
  const current = (): PrDriver => {
    const { kind, remote } = config.forge
    const key = `${kind}\n${remote}`
    let driver = drivers.get(key)
    if (driver === undefined) {
      driver = makePrDriver(kind, remote)
      drivers.set(key, driver)
    }
    return driver
  }
  return {
    createPr: (opts) => current().createPr(opts),
    getPr: (cwd, number) => current().getPr(cwd, number),
    getPrLabels: (cwd, number) => current().getPrLabels(cwd, number),
    listOpenPrs: (cwd) => current().listOpenPrs(cwd),
    getMergeStatus: (cwd, number) => current().getMergeStatus(cwd, number),
    getPrDiff: (cwd, number) => current().getPrDiff(cwd, number),
    listComments: (cwd, number) => current().listComments(cwd, number),
    postComment: (cwd, number, body) => current().postComment(cwd, number, body),
    closePr: (cwd, number, reason) => current().closePr(cwd, number, reason),
    addLabel: (cwd, number, label) => current().addLabel(cwd, number, label),
    removeLabel: (cwd, number, label) => current().removeLabel(cwd, number, label),
    deleteBranch: (cwd, remote, branch) => current().deleteBranch(cwd, remote, branch),
  }
}

const defaultStoreFor = (key: string): Store => new Store(openDatabase(dbPathForRepo(key)))
