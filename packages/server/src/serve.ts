import type { Store, Tracker } from '@amagi/core'
import { createApp } from './app.ts'
import { startGatePoller } from './gate-poller.ts'

export type ServeOptions = {
  store: Store
  host: string
  port: number
  tracker?: Tracker
  gatePollIntervalMs?: number
}

export function serve({ store, host, port, tracker, gatePollIntervalMs }: ServeOptions) {
  const app = createApp({
    store,
    ...(tracker === undefined ? {} : { tracker }),
  })
  const poller =
    tracker === undefined
      ? null
      : startGatePoller({
          store,
          tracker,
          ...(gatePollIntervalMs === undefined ? {} : { intervalMs: gatePollIntervalMs }),
        })
  const server = Bun.serve({ hostname: host, port, fetch: app.fetch })
  return {
    hostname: server.hostname,
    port: server.port,
    url: server.url,
    stop(closeActiveConnections?: boolean): Promise<void> {
      poller?.stop()
      return server.stop(closeActiveConnections)
    },
  }
}
