import type { Store } from '@amagi/core'
import { createApp } from './app.ts'

export type ServeOptions = {
  store: Store
  host: string
  port: number
}

export function serve({ store, host, port }: ServeOptions) {
  const app = createApp({ store })
  return Bun.serve({ hostname: host, port, fetch: app.fetch })
}
