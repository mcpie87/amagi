import { type BeadsService, fmtBytes } from '@amagi/core'
import { type Poller, startPoller } from './poller.ts'

export type BeadsGcPollerOptions = {
  repo: string
  beads: BeadsService
  intervalMs: number
}

/**
 * Collects a repo's beads garbage on start and then every interval, so a
 * store that bloated while the server was down is fixed straight away.
 */
export function startBeadsGcPoller({ repo, beads, intervalMs }: BeadsGcPollerOptions): Poller {
  return startPoller(
    intervalMs,
    async () => {
      const run = await beads.gc()
      if (run === null) return
      if (!run.ok) {
        console.warn(`beads gc ${repo}: ${run.error}`)
        return
      }
      if (run.sizeAfterBytes < run.sizeBeforeBytes) {
        console.info(
          `repo ${repo}: beads gc ${fmtBytes(run.sizeBeforeBytes)} -> ${fmtBytes(run.sizeAfterBytes)}`,
        )
      }
    },
    true,
  )
}
