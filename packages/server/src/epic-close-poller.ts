import { BeadsTracker, errMsg, type Tracker } from '@amagi/core'
import { startPoller } from './poller.ts'

export type EpicClosePollerOptions = {
  repo: string
  tracker: Tracker
  intervalMs?: number | undefined
}

export type EpicClosePoller = {
  stop(): void
}

const DEFAULT_INTERVAL_MS = 300_000

/** Closes epics that bd reports eligible after all their children complete. */
export function startEpicClosePoller({
  repo,
  tracker,
  intervalMs = DEFAULT_INTERVAL_MS,
}: EpicClosePollerOptions): EpicClosePoller {
  if (!(tracker instanceof BeadsTracker)) return { stop: () => undefined }

  return startPoller(intervalMs, async () => {
    try {
      const result = await tracker.closeEligibleEpics('All children completed')
      if (result.closed.length > 0) {
        console.info(`repo ${repo}: closed eligible epics ${result.closed.join(', ')}`)
      }
    } catch (err) {
      console.warn(`epic close poll ${repo}: ${errMsg(err)}`)
    }
  })
}
