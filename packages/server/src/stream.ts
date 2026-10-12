import { AsyncQueue, compactReplayEvent, type Store, type StoredEvent } from '@amagi/core'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'

/** Matches the `events` default so a long backlog pages instead of truncating. */
const BACKLOG_PAGE = 500
const HEARTBEAT_MS = 15_000
const connectedStreams = new WeakMap<Store, number>()

export function streamClientCount(store: Store): number {
  return connectedStreams.get(store) ?? 0
}

type Tick = 'tick'

const isTransientNotice = (event: StoredEvent): boolean =>
  event.type === 'notify.idle' || event.type === 'notify.failed'

export type EventStreamOptions = {
  taskId?: string
  sinceSeq: number
  /**
   * Replay the backlog as `compactReplayEvent` trims it, then send a `replayed`
   * event carrying the last backlog seq, so the client knows which lines it
   * must fetch per task and which will arrive live.
   */
  compact?: boolean
}

/**
 * Subscribing before the backlog is read is what makes the replay gapless: an
 * event appended while the backlog pages out is already queued, and the
 * `seq <= cursor` check drops it if that page carried it too.
 */
export function eventStream(
  c: Context,
  store: Store,
  { taskId, sinceSeq, compact = false }: EventStreamOptions,
) {
  const scope = { taskId }

  return streamSSE(c, async (stream) => {
    connectedStreams.set(store, streamClientCount(store) + 1)
    let released = false
    const live = new AsyncQueue<StoredEvent | Tick>()
    const unsubscribe = store.subscribe((event) => {
      if (taskId === undefined || event.taskId === taskId) live.push(event)
    })
    const heartbeat = setInterval(() => live.push('tick'), HEARTBEAT_MS)
    const release = () => {
      if (released) return
      released = true
      clearInterval(heartbeat)
      unsubscribe()
      live.close()
      connectedStreams.set(store, Math.max(0, streamClientCount(store) - 1))
    }
    stream.onAbort(release)

    // JSON.stringify escapes newlines, so one `data:` line always carries the event.
    const frame = (event: StoredEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`

    try {
      let cursor = sinceSeq
      for (;;) {
        const page = store.events({
          ...scope,
          sinceSeq: cursor,
          limit: BACKLOG_PAGE,
          withoutAgentLog: compact,
          withoutWatcherRuns: compact,
        })
        let chunk = ''
        for (const event of page) {
          const sent = compact ? compactReplayEvent(event) : isTransientNotice(event) ? null : event
          if (sent !== null) chunk += frame(sent)
          cursor = event.seq
        }
        if (chunk !== '') await stream.write(chunk)
        if (page.length < BACKLOG_PAGE || stream.aborted) break
      }
      if (compact) {
        // The backlog skipped lines up to the store's head, not just up to the
        // last event it sent. The cursor must stay put: an event appended since
        // the last page is already queued live and would be dropped.
        const replayed = Math.max(cursor, store.latestSeq())
        await stream.writeSSE({ event: 'replayed', data: String(replayed) })
      }

      for await (const event of live) {
        if (event === 'tick') {
          // An SSE comment: keeps idle proxies from reaping the connection and
          // is ignored by every client.
          await stream.write(': ping\n\n')
          continue
        }
        if (event.seq <= cursor && !isTransientNotice(event)) continue
        cursor = Math.max(cursor, event.seq)
        await stream.write(frame(event))
      }
    } finally {
      release()
    }
  })
}
