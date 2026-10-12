import { useEffect, useState } from 'react'
import { apiBase } from './api.ts'
import { type FromHub, Hub, type PollResult, type StreamStatus, type ToHub } from './hub.ts'

export type { PollResult, StreamStatus }

const listeners = new Set<(message: FromHub) => void>()
const lastPoll = new Map<string, PollResult>()
const pollCounts = new Map<string, number>()
let port: MessagePort | null = null

function connect(): MessagePort {
  if (typeof SharedWorker !== 'undefined') {
    return new SharedWorker(new URL('./hub-worker.ts', import.meta.url), {
      type: 'module',
      name: 'amagi-hub',
    }).port
  }
  const channel = new MessageChannel()
  new Hub(apiBase).attach(channel.port2)
  return channel.port1
}

function send(message: ToHub): void {
  if (port === null) {
    port = connect()
    port.onmessage = (event: MessageEvent<FromHub>) => {
      if (event.data.type === 'poll') lastPoll.set(event.data.url, event.data.result)
      for (const listener of listeners) listener(event.data)
    }
    window.addEventListener('pagehide', () => port?.postMessage({ type: 'bye' } satisfies ToHub))
    // The hub dropped this page's subscriptions on pagehide and the restored
    // page's effects will not run again to renew them.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) location.reload()
    })
  }
  port.postMessage(message)
}

export type RepoFeedHandlers = {
  status(status: StreamStatus): void
  /** Raw SSE `data` payloads in seq order. */
  events(data: string[]): void
  replayed(seq: number): void
}

/** Follows a repo's shared event stream; a tab may follow each repo once. */
export function followRepo(repo: string, on: RepoFeedHandlers): () => void {
  const listener = (message: FromHub) => {
    if (message.type === 'poll' || message.repo !== repo) return
    if (message.type === 'status') on.status(message.status)
    else if (message.type === 'events') on.events(message.data)
    else on.replayed(message.seq)
  }
  listeners.add(listener)
  send({ type: 'stream', repo })
  return () => {
    listeners.delete(listener)
    send({ type: 'unstream', repo })
  }
}

/** Reconnects the repo's stream for every tab, resuming after the last event the hub saw. */
export function resyncRepo(repo: string): void {
  send({ type: 'resync', repo })
}

/** Polls `url` now instead of at its next tick; every tab following it gets the answer. */
export function refreshPoll(url: string): void {
  send({ type: 'refresh', url })
}

export const pollOk = (
  result: PollResult | undefined,
): result is { status: number; body: unknown } =>
  result != null && result.status >= 200 && result.status < 300

/**
 * The latest answer for `url`, polled every `ms` by the hub once for all
 * tabs. Undefined until the first answer, and while `url` is null.
 */
export function usePoll(url: string | null, ms: number): PollResult | undefined {
  const [latest, setLatest] = useState<{ url: string; result: PollResult } | null>(null)

  useEffect(() => {
    if (url === null) return
    const cached = lastPoll.get(url)
    if (cached !== undefined) setLatest({ url, result: cached })
    const listener = (message: FromHub) => {
      if (message.type === 'poll' && message.url === url) setLatest({ url, result: message.result })
    }
    listeners.add(listener)
    const count = pollCounts.get(url) ?? 0
    pollCounts.set(url, count + 1)
    if (count === 0) send({ type: 'poll', url, ms })
    return () => {
      listeners.delete(listener)
      const left = (pollCounts.get(url) ?? 1) - 1
      if (left > 0) {
        pollCounts.set(url, left)
        return
      }
      pollCounts.delete(url)
      send({ type: 'unpoll', url })
    }
  }, [url, ms])

  // A stale answer for the previous url must not show under the new one.
  return latest !== null && latest.url === url ? latest.result : undefined
}
