import type { StoredEvent } from '@amagi/core'

export type SseEvent = { id?: string; event?: string; data: string }

/**
 * Splits a growing text buffer into complete `\n\n`-terminated SSE blocks,
 * returning the parsed events found so far and the incomplete remainder to
 * prepend to the next chunk.
 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: SseEvent[] = []

  for (const block of blocks) {
    let data = ''
    let id: string | undefined
    let event: string | undefined
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue
      if (line.startsWith('data:')) data += (data === '' ? '' : '\n') + line.slice(5).trimStart()
      else if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('event:')) event = line.slice(6).trim()
    }
    if (data !== '') {
      events.push({
        data,
        ...(id !== undefined ? { id } : {}),
        ...(event !== undefined ? { event } : {}),
      })
    }
  }

  return { events, rest }
}

export type StreamHandle = { close(): void }

const RETRY_DELAY_MS = 1000

/**
 * A Node/Bun-side stand-in for the browser's EventSource: no global
 * implementation exists in this runtime, so the SSE wire format is parsed by
 * hand over a fetch ReadableStream. Reconnects on drop, resuming from the
 * last seq seen so a restart of `amagi serve` never replays or drops events.
 */
export function subscribeToStream(
  baseUrl: string,
  scope: { taskId?: string },
  onEvent: (event: StoredEvent) => void,
): StreamHandle {
  const controller = new AbortController()
  let closed = false
  let sinceSeq = 0

  async function connectOnce(): Promise<void> {
    const qs = new URLSearchParams({ sinceSeq: String(sinceSeq) })
    if (scope.taskId !== undefined) qs.set('taskId', scope.taskId)
    const res = await fetch(`${baseUrl}/api/stream?${qs}`, { signal: controller.signal })
    if (!res.ok || res.body === null) throw new Error(`stream request failed: HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseChunk(buffer)
      buffer = parsed.rest
      for (const raw of parsed.events) {
        try {
          const event = JSON.parse(raw.data) as StoredEvent
          sinceSeq = event.seq + 1
          onEvent(event)
        } catch {
          // a malformed event must not drop the stream
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!closed) {
      try {
        await connectOnce()
      } catch {
        // connection dropped or refused; retry below unless closed
      }
      if (closed) return
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }

  void loop()

  return {
    close() {
      closed = true
      controller.abort()
    },
  }
}
