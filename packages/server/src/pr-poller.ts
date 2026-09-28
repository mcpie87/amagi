import {
  errMsg,
  exec,
  type PrDriver,
  reconcilePrs,
  resolveForgeRemote,
  type Store,
  type Tracker,
} from '@amagi/core'
import { startPoller } from './poller.ts'

export type PrPollerOptions = {
  store: Store
  forge: PrDriver
  /** Settles the tracker issue (close/setStatus) when a PR leaves the live set. */
  tracker: Tracker
  /** Repo the open PRs live in, so the forge CLI can resolve them. */
  cwd: string
  /** Remote the settled PRs' branches are deleted from. */
  remote: string
  forgeKind?: 'github' | 'gitlab' | 'forgejo'
  configuredRemote?: string | null
  intervalMs?: number | undefined
}

export type PrPoller = {
  stop(): void
}

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Pull requests are closed or merged out of band, so the runner (which only
 * lives during a task run) never sees it. Polling the remote state here keeps
 * tasks from sitting in pr_open forever after their PR is settled.
 */
export function startPrPoller({
  store,
  forge,
  tracker,
  cwd,
  remote,
  forgeKind,
  configuredRemote,
  intervalMs = DEFAULT_INTERVAL_MS,
}: PrPollerOptions): PrPoller {
  return startPoller(intervalMs, async () => {
    try {
      const selected =
        forgeKind === undefined
          ? remote
          : await resolveForgeRemote(exec, cwd, forgeKind, configuredRemote ?? null)
      await reconcilePrs(store, forge, tracker, cwd, selected)
    } catch (err) {
      console.warn(`pr reconcile: ${errMsg(err)}`)
    }
  })
}
