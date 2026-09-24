import { AsyncQueue, type Store, type StoredEvent } from '@amagi/core'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

/** Matches the `events` default so a long backlog pages instead of truncating. */
const BACKLOG_PAGE = 500
const HEARTBEAT_MS = 15_000

type Tick = 'tick'

export type EventStreamOptions = {
  taskId?: string
  sinceSeq: number
}

/**
 * Subscribing before the backlog is read is what makes the replay gapless: an
 * event appended while the backlog pages out is already queued, and the
 * `seq <= cursor` check drops it if that page carried it too.
 */
export function eventStream(c: Context, store: Store, { taskId, sinceSeq }: EventStreamOptions) {
  const scope = { taskId }

  return streamSSE(c, async (stream) => {
    const live = new AsyncQueue<StoredEvent | Tick>()
    const unsubscribe = store.subscribe((event) => {
      if (taskId === undefined || event.taskId === taskId) live.push(event)
    })
    const heartbeat = setInterval(() => live.push('tick'), HEARTBEAT_MS)
    const release = () => {
      clearInterval(heartbeat)
      unsubscribe()
      live.close()
    }
    stream.onAbort(release)

    const send = (event: StoredEvent) =>
      stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) })

    try {
      let cursor = sinceSeq
      for (;;) {
        const page = store.events({ ...scope, sinceSeq: cursor, limit: BACKLOG_PAGE })
        for (const event of page) {
          await send(event)
          cursor = event.seq
        }
        if (page.length < BACKLOG_PAGE || stream.aborted) break
      }

      for await (const event of live) {
        if (event === 'tick') {
          // An SSE comment: keeps idle proxies from reaping the connection and
          // is ignored by every client.
          await stream.write(': ping\n\n')
          continue
        }
        if (event.seq <= cursor) continue
        cursor = event.seq
        await send(event)
      }
    } finally {
      release()
    }
  })
}
