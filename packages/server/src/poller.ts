export type Poller = {
  stop(): void
}

/**
 * Runs an async tick every intervalMs, re-arming with setTimeout after each
 * tick resolves unless stopped. A tick never overlaps the previous one.
 */
export function startPoller(intervalMs: number, tick: () => Promise<void>): Poller {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function run(): Promise<void> {
    await tick()
    if (!stopped) timer = setTimeout(() => void run(), intervalMs)
  }

  timer = setTimeout(() => void run(), intervalMs)
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
