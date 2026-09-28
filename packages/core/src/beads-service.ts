import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BeadsBlocker,
  BeadsIssue,
  BeadsTracker,
  EpicCloseEligible,
} from './drivers/tracker/beads.ts'

/**
 * Dolt rewrites its manifest on every commit, whether bd, amagi or a sync
 * made it, and leaves it alone on reads, so its bytes pin the database state.
 * null (a server-mode or unreadable store) turns caching off.
 */
export function embeddedDoltVersion(repoRoot: string): string | null {
  try {
    const beads = join(repoRoot, '.beads')
    const meta = JSON.parse(readFileSync(join(beads, 'metadata.json'), 'utf8')) as {
      dolt_mode?: string
      dolt_database?: string
    }
    if (meta.dolt_mode !== 'embedded' || !meta.dolt_database) return null
    return readFileSync(
      join(beads, 'embeddeddolt', meta.dolt_database, '.dolt', 'noms', 'manifest'),
      'latin1',
    )
  } catch {
    return null
  }
}

/**
 * One repo's beads reads for the UIs and API. Results are reused until the
 * Dolt manifest changes, and concurrent identical reads share one bd process.
 * Scheduling (ready, claim, heartbeat, gates) must keep calling the tracker:
 * its answers also change with time (lease expiry, defer dates), which the
 * manifest cannot see.
 */
export class BeadsService {
  private version: string | null = null
  private readonly entries = new Map<string, Promise<unknown>>()

  constructor(
    readonly tracker: BeadsTracker,
    private readonly root: string,
    private readonly versionOf: (root: string) => string | null = embeddedDoltVersion,
  ) {}

  list(): Promise<BeadsIssue[]> {
    return this.read('list', () => this.tracker.list())
  }

  openWithLabel(label: string): Promise<BeadsIssue[]> {
    return this.read(`label:${label}`, () => this.tracker.openWithLabel(label))
  }

  getIssue(id: string): Promise<BeadsIssue | null> {
    return this.read(`issue:${id}`, () => this.tracker.getIssue(id))
  }

  dependents(id: string): Promise<BeadsBlocker[]> {
    return this.read(`dependents:${id}`, () => this.tracker.dependents(id))
  }

  children(id: string): Promise<BeadsIssue[]> {
    return this.read(`children:${id}`, () => this.tracker.children(id))
  }

  eligibleEpics(): Promise<EpicCloseEligible[]> {
    return this.read('eligible-epics', () => this.tracker.eligibleEpics())
  }

  private read<T>(key: string, load: () => Promise<T>): Promise<T> {
    // Read the version before bd runs: a write landing mid-read then leaves
    // the entry filed under the older version, so the next read reloads.
    const version = this.versionOf(this.root)
    if (version === null) return load()
    if (version !== this.version) {
      this.entries.clear()
      this.version = version
    }
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit as Promise<T>
    const pending = load()
    this.entries.set(key, pending)
    pending.catch(() => {
      if (this.entries.get(key) === pending) this.entries.delete(key)
    })
    return pending
  }
}
