export type Poller = {
  stop(): void
  trigger(): void
}

/**
 * Runs an async tick every intervalMs, re-arming with setTimeout after each
 * tick resolves unless stopped. A tick never overlaps the previous one.
 */
export function startPoller(
  intervalMs: number,
  tick: () => Promise<void>,
  runImmediately = false,
): Poller {
  let stopped = false
  let running = false
  let triggerRequested = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function run(): Promise<void> {
    if (stopped || running) return
    running = true
    try {
      await tick()
    } finally {
      running = false
    }
    if (!stopped) {
      const delay = triggerRequested ? 0 : intervalMs
      triggerRequested = false
      timer = setTimeout(() => void run(), delay)
    }
  }

  if (runImmediately) void run()
  else timer = setTimeout(() => void run(), intervalMs)
  return {
    trigger() {
      if (stopped) return
      triggerRequested = true
      if (running) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void run(), 0)
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
