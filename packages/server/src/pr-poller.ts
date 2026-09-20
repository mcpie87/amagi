import { type PrDriver, reconcilePrs, type Store } from '@amagi/core'

export type PrPollerOptions = {
  store: Store
  forge: PrDriver
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
  cwd,
  intervalMs = DEFAULT_INTERVAL_MS,
}: PrPollerOptions): PrPoller {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function tick(): Promise<void> {
    try {
      await reconcilePrs(store, forge, cwd)
    } catch (err) {
      console.warn(`pr reconcile: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
