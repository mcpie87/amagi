import { describe, expect, test } from 'bun:test'
import type { FromHub, PollResult, SourceHandlers } from './hub.ts'
import { Hub } from './hub.ts'

const event = (seq: number, body: Record<string, unknown>) =>
  JSON.stringify({ seq, ts: seq, taskId: 't1', ...body })

function setup(load: (url: string) => Promise<PollResult> = async () => null) {
  const sources: { url: string; on: SourceHandlers; closed: boolean }[] = []
  const hub = new Hub(
    '',
    (url, on) => {
      const source = { url, on, closed: false }
      sources.push(source)
      return { close: () => (source.closed = true) }
    },
    load,
  )
  const tab = () => {
    const got: FromHub[] = []
    return { got, postMessage: (message: FromHub) => got.push(message) }
  }
  return { hub, sources, tab }
}

describe('Hub', () => {
  test('a joining tab gets the compact backlog and the head as its replay mark', () => {
    const { hub, sources, tab } = setup()
    const first = tab()
    hub.receive(first, { type: 'stream', repo: 'r' })
    const feed = sources[0]
    if (feed === undefined) throw new Error('no source')
    expect(feed.url).toBe('/api/repos/r/stream?sinceSeq=0&compact=1')
    feed.on.message(event(1, { type: 'task.claimed' }))
    feed.on.replayed(5)
    const line = event(6, { type: 'agent.stream', role: 'implement', event: { kind: 'text' } })
    feed.on.message(line)

    const second = tab()
    hub.receive(second, { type: 'stream', repo: 'r' })

    expect(sources).toHaveLength(1)
    expect(first.got.filter((m) => m.type === 'events').flatMap((m) => m.data)).toContain(line)
    expect(second.got).toEqual([
      { type: 'status', repo: 'r', status: 'connecting' },
      { type: 'events', repo: 'r', data: [event(1, { type: 'task.claimed' })] },
      { type: 'replayed', repo: 'r', seq: 6 },
    ])
  })

  test('a replay cut short marks what arrived and resyncs without compaction', () => {
    const { hub, sources, tab } = setup()
    const only = tab()
    hub.receive(only, { type: 'stream', repo: 'r' })
    sources[0]?.on.message(event(3, { type: 'task.claimed' }))
    sources[0]?.on.error(false)

    expect(only.got).toContainEqual({ type: 'replayed', repo: 'r', seq: 3 })

    hub.receive(only, { type: 'resync', repo: 'r' })
    expect(sources[0]?.closed).toBe(true)
    expect(sources[1]?.url).toBe('/api/repos/r/stream?sinceSeq=3')

    hub.receive(only, { type: 'bye' })
    expect(sources[1]?.closed).toBe(true)
  })

  test('a stream the browser closed is reopened from the last seq', async () => {
    const { hub, sources, tab } = setup()
    const only = tab()
    hub.receive(only, { type: 'stream', repo: 'r' })
    sources[0]?.on.message(event(4, { type: 'task.claimed' }))
    sources[0]?.on.error(true)

    await Bun.sleep(1_100)
    expect(sources[1]?.url).toBe('/api/repos/r/stream?sinceSeq=4')
    hub.receive(only, { type: 'bye' })
  })

  test('tabs polling one url share a single request', async () => {
    let loads = 0
    const { hub, tab } = setup(async () => ({ status: 200, body: ++loads }))
    const first = tab()
    const second = tab()
    hub.receive(first, { type: 'poll', url: '/api/seats', ms: 60_000 })
    await Promise.resolve()
    hub.receive(second, { type: 'poll', url: '/api/seats', ms: 60_000 })

    expect(loads).toBe(1)
    expect(second.got).toEqual([
      { type: 'poll', url: '/api/seats', result: { status: 200, body: 1 } },
    ])
    hub.receive(first, { type: 'bye' })
    hub.receive(second, { type: 'bye' })
  })
})
