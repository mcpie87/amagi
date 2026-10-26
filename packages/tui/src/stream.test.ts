import { describe, expect, test } from 'bun:test'
import { parseSseChunk, subscribeToStream } from './stream.ts'

const frame = (seq: number, body: object): string =>
  `id: ${seq}\ndata: ${JSON.stringify({ seq, ts: 1000, taskId: 'am-1', ...body })}\n\n`

describe('parseSseChunk', () => {
  test('parses a single complete event', () => {
    const chunk = frame(1, { type: 'task.claimed', title: 'Fix it', tracker: 'beads' })
    const { events, rest } = parseSseChunk(chunk)
    expect(rest).toBe('')
    expect(events).toHaveLength(1)
    expect(events[0]?.id).toBe('1')
    const parsed = JSON.parse(events[0]?.data ?? '{}')
    expect(parsed.type).toBe('task.claimed')
  })

  test('holds back an incomplete trailing block for the next chunk', () => {
    const complete = frame(1, { type: 'task.claimed', title: 'Fix it', tracker: 'beads' })
    const partial = 'id: 2\ndata: {"seq":2'
    const { events, rest } = parseSseChunk(complete + partial)
    expect(events).toHaveLength(1)
    expect(rest).toBe(partial)
  })

  test('ignores heartbeat comments', () => {
    const { events } = parseSseChunk(': ping\n\n')
    expect(events).toHaveLength(0)
  })

  test('parses several events delivered in one chunk', () => {
    const chunk =
      frame(1, { type: 'task.claimed', title: 'a', tracker: 'beads' }) +
      frame(2, { type: 'task.state', from: 'claimed', to: 'implementing' })
    const { events } = parseSseChunk(chunk)
    expect(events).toHaveLength(2)
    expect(JSON.parse(events[1]?.data ?? '{}').to).toBe('implementing')
  })

  test('joins multi-line data fields with a newline, per the SSE spec', () => {
    const { events } = parseSseChunk('data: line one\ndata: line two\n\n')
    expect(events[0]?.data).toBe('line one\nline two')
  })
})

describe('subscribeToStream', () => {
  test('resumes from the last seen seq, which the server reads as exclusive', async () => {
    const asked: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        asked.push(new URL(req.url).searchParams.get('sinceSeq') ?? '')
        return new Response(frame(5, { type: 'task.claimed', title: 'x', tracker: 'beads' }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const handle = subscribeToStream(`http://127.0.0.1:${server.port}`, 'repo1', {}, () => {})
    try {
      const deadline = Date.now() + 5_000
      while (asked.length < 2 && Date.now() < deadline) await Bun.sleep(20)
      expect(asked.slice(0, 2)).toEqual(['0', '5'])
    } finally {
      handle.close()
      await server.stop(true)
    }
  })
})
