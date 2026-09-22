import { errMsg, type PrDriver, reconcilePrs, type Store, type Tracker } from '@amagi/core'
import { startPoller } from './poller.ts'

export type PrPollerOptions = {
  store: Store
  forge: PrDriver
  /** Settles the tracker issue (close/setStatus) when a PR leaves the live set. */
  tracker: Tracker
  /** Repo the open PRs live in, so the forge CLI can resolve them. */
  cwd: string
  intervalMs?: number
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
  intervalMs = DEFAULT_INTERVAL_MS,
}: PrPollerOptions): PrPoller {
  return startPoller(intervalMs, async () => {
    try {
      await reconcilePrs(store, forge, tracker, cwd)
    } catch (err) {
      console.warn(`pr reconcile: ${errMsg(err)}`)
    }
  })
}
