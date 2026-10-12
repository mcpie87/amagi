import type { StoredEvent } from '@amagi/core/events'
import { compactReplayEvent } from '@amagi/core/view'

export type StreamStatus = 'connecting' | 'connected' | 'reconnecting'

/** A poll's last answer: the HTTP status and parsed body, or null when the request failed. */
export type PollResult = { status: number; body: unknown } | null

export type ToHub =
  | { type: 'stream'; repo: string }
  | { type: 'unstream'; repo: string }
  | { type: 'resync'; repo: string }
  | { type: 'poll'; url: string; ms: number }
  | { type: 'unpoll'; url: string }
  | { type: 'refresh'; url: string }
  | { type: 'bye' }

export type FromHub =
  | { type: 'status'; repo: string; status: StreamStatus }
  /** Raw SSE `data` payloads in seq order: a joining tab's backlog, then live events. */
  | { type: 'events'; repo: string; data: string[] }
  | { type: 'replayed'; repo: string; seq: number }
  | { type: 'poll'; url: string; result: PollResult }

export type Port = { postMessage(message: FromHub): void }

export type SourceHandlers = {
  open(): void
  error(): void
  replayed(seq: number): void
  message(data: string): void
}

export type Connect = (url: string, on: SourceHandlers) => { close(): void }

export const connectEventSource: Connect = (url, on) => {
  const source = new EventSource(url)
  source.addEventListener('open', on.open)
  source.addEventListener('error', on.error)
  source.addEventListener('replayed', (event) => on.replayed(Number((event as MessageEvent).data)))
  source.addEventListener('message', (event) => on.message((event as MessageEvent).data))
  return source
}

export const loadJson = (url: string): Promise<PollResult> =>
  fetch(url)
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
    .catch(() => null)

type Feed = {
  ports: Set<Port>
  source: { close(): void }
  /** What a fresh compact replay would carry, up to `latestSeq`. */
  backlog: string[]
  latestSeq: number
  replayed: number | null
  status: StreamStatus
}

type Poll = {
  ports: Set<Port>
  timer: ReturnType<typeof setInterval>
  result: PollResult | undefined
  /** Responses can land out of order; only the newest request's answer is kept. */
  sent: number
  applied: number
}

/**
 * Fans one event stream per repo and one timer per polled url out to every
 * tab, so the tab count costs neither connections nor server work. Runs in a
 * SharedWorker, or inside the page where SharedWorker is missing. A tab that
 * joins a live feed gets the compact backlog the hub kept plus a `replayed`
 * mark at the feed's head, exactly what its own compact connection would give.
 */
export class Hub {
  private readonly feeds = new Map<string, Feed>()
  private readonly polls = new Map<string, Poll>()

  constructor(
    private readonly apiBase: string,
    private readonly connect: Connect = connectEventSource,
    private readonly load: (url: string) => Promise<PollResult> = loadJson,
  ) {}

  attach(port: MessagePort): void {
    port.onmessage = (event: MessageEvent<ToHub>) => this.receive(port, event.data)
  }

  receive(port: Port, message: ToHub): void {
    switch (message.type) {
      case 'stream':
        this.stream(port, message.repo)
        return
      case 'unstream':
        this.unstream(port, message.repo)
        return
      case 'resync': {
        const feed = this.feeds.get(message.repo)
        if (feed === undefined) return
        feed.source.close()
        this.endReplay(message.repo, feed)
        this.open(message.repo, feed)
        return
      }
      case 'poll':
        this.poll(port, message.url, message.ms)
        return
      case 'unpoll':
        this.unpoll(port, message.url)
        return
      case 'refresh': {
        const poll = this.polls.get(message.url)
        if (poll !== undefined) this.fetchPoll(message.url, poll)
        return
      }
      case 'bye':
        for (const repo of [...this.feeds.keys()]) this.unstream(port, repo)
        for (const url of [...this.polls.keys()]) this.unpoll(port, url)
        return
    }
  }

  private stream(port: Port, repo: string): void {
    const existing = this.feeds.get(repo)
    if (existing === undefined) {
      const feed: Feed = {
        ports: new Set([port]),
        source: { close: () => {} },
        backlog: [],
        latestSeq: 0,
        replayed: null,
        status: 'connecting',
      }
      this.feeds.set(repo, feed)
      this.open(repo, feed)
      return
    }
    existing.ports.add(port)
    port.postMessage({ type: 'status', repo, status: existing.status })
    port.postMessage({ type: 'events', repo, data: existing.backlog })
    // Mid-replay the server's own mark is still to come and reaches this port
    // too. The server's mark can sit past the last event it sent: the log
    // lines in between were skipped, so this tab must backfill them as well.
    if (existing.replayed !== null)
      port.postMessage({
        type: 'replayed',
        repo,
        seq: Math.max(existing.replayed, existing.latestSeq),
      })
  }

  private unstream(port: Port, repo: string): void {
    const feed = this.feeds.get(repo)
    if (feed === undefined || !feed.ports.delete(port) || feed.ports.size > 0) return
    feed.source.close()
    this.feeds.delete(repo)
  }

  private open(repo: string, feed: Feed): void {
    const compact = feed.latestSeq === 0
    feed.source = this.connect(
      `${this.apiBase}/api/repos/${repo}/stream?sinceSeq=${feed.latestSeq}${compact ? '&compact=1' : ''}`,
      {
        open: () => this.setStatus(repo, feed, 'connected'),
        error: () => {
          this.endReplay(repo, feed)
          this.setStatus(repo, feed, 'reconnecting')
        },
        replayed: (seq) => {
          feed.replayed = seq
          this.broadcast(feed, { type: 'replayed', repo, seq })
        },
        message: (data) => this.receiveEvent(repo, feed, data),
      },
    )
  }

  /**
   * A replay cut short resumes without compaction, so the server never sends
   * its mark; the tabs must backfill log lines up to what arrived and take
   * later ones live.
   */
  private endReplay(repo: string, feed: Feed): void {
    if (feed.replayed !== null || feed.latestSeq === 0) return
    feed.replayed = feed.latestSeq
    this.broadcast(feed, { type: 'replayed', repo, seq: feed.latestSeq })
  }

  private receiveEvent(repo: string, feed: Feed, data: string): void {
    let event: StoredEvent
    try {
      event = JSON.parse(data) as StoredEvent
    } catch {
      return
    }
    if (event.seq <= feed.latestSeq) return
    feed.latestSeq = event.seq
    const kept = compactReplayEvent(event)
    if (kept !== null) feed.backlog.push(kept === event ? data : JSON.stringify(kept))
    this.broadcast(feed, { type: 'events', repo, data: [data] })
  }

  private setStatus(repo: string, feed: Feed, status: StreamStatus): void {
    feed.status = status
    this.broadcast(feed, { type: 'status', repo, status })
  }

  private broadcast(target: { ports: Set<Port> }, message: FromHub): void {
    for (const port of target.ports) port.postMessage(message)
  }

  private poll(port: Port, url: string, ms: number): void {
    const existing = this.polls.get(url)
    if (existing !== undefined) {
      existing.ports.add(port)
      if (existing.result !== undefined)
        port.postMessage({ type: 'poll', url, result: existing.result })
      return
    }
    const poll: Poll = {
      ports: new Set([port]),
      timer: setInterval(() => this.fetchPoll(url, poll), ms),
      result: undefined,
      sent: 0,
      applied: 0,
    }
    this.polls.set(url, poll)
    this.fetchPoll(url, poll)
  }

  private unpoll(port: Port, url: string): void {
    const poll = this.polls.get(url)
    if (poll === undefined || !poll.ports.delete(port) || poll.ports.size > 0) return
    clearInterval(poll.timer)
    this.polls.delete(url)
  }

  private fetchPoll(url: string, poll: Poll): void {
    const id = ++poll.sent
    void this.load(url).then((result) => {
      if (id <= poll.applied) return
      poll.applied = id
      poll.result = result
      this.broadcast(poll, { type: 'poll', url, result })
    })
  }
}
