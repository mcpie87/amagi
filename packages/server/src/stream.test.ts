import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Store, StoredEvent } from '@amagi/core'
import { type AppType, createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
let store: import('@amagi/core').Store
let app: AppType

const claim = (id: string) =>
  store.append(id, { type: 'task.claimed', title: `work on ${id}`, tracker: 'beads' })

beforeEach(() => {
  ws = testWorkspaces(['repo1'])
  store = ws.store('repo1')
  app = createApp({ workspaces: ws.workspaces })
})

afterEach(() => {
  ws.cleanup()
})

type Frame = { id: string | undefined; event: StoredEvent }

/**
 * Pulls SSE frames off the response until `count` of them have arrived. The
 * reader stays open so the test can append while the stream is live; call
 * `close` to hang up the way a browser tab does.
 */
function sse(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Frame[] = []

  const take = async (count: number): Promise<Frame[]> => {
    while (frames.length < count) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`stream ended with ${frames.length} of ${count} frames`)
      buffer += decoder.decode(value, { stream: true })
      let cut = buffer.indexOf('\n\n')
      while (cut !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const lines = block.split('\n').filter((l) => !l.startsWith(':'))
        const data = lines.find((l) => l.startsWith('data: '))
        if (data) {
          frames.push({
            id: lines.find((l) => l.startsWith('id: '))?.slice(4),
            event: JSON.parse(data.slice(6)) as StoredEvent,
          })
        }
        cut = buffer.indexOf('\n\n')
      }
    }
    return frames.splice(0, count)
  }

  return { take, close: () => reader.cancel() }
}

const noise = (i: number) =>
  store.append(null, { type: 'notify.sent', channel: 'test', title: `line ${i}` })

/** Lets the stream callback run between an append and the next assertion. */
const settle = () => new Promise((r) => setTimeout(r, 10))

describe('GET /api/repos/repo1/stream', () => {
  test('replays the backlog and then pushes live events', async () => {
    claim('bd-1')
    const stream = sse(await app.request('/api/repos/repo1/stream'))

    const [replayed] = await stream.take(1)
    expect(replayed?.event.type).toBe('task.claimed')

    const live = store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(live.seq)
    expect(pushed?.id).toBe(String(live.seq))

    await stream.close()
  })

  test('resumes from Last-Event-ID with no gap and no duplicate', async () => {
    const first = claim('bd-1')
    const missed = store.append('bd-1', {
      type: 'task.state',
      from: 'claimed',
      to: 'worktree_ready',
    })

    const stream = sse(
      await app.request('/api/repos/repo1/stream', {
        headers: { 'Last-Event-ID': String(first.seq) },
      }),
    )
    const live = store.append('bd-1', {
      type: 'task.state',
      from: 'worktree_ready',
      to: 'implementing',
    })

    const seqs = (await stream.take(2)).map((f) => f.event.seq)
    expect(seqs).toEqual([missed.seq, live.seq])

    await stream.close()
  })

  test('the header wins over a stale sinceSeq baked into the url', async () => {
    const first = claim('bd-1')
    const second = store.append('bd-1', {
      type: 'task.state',
      from: 'claimed',
      to: 'worktree_ready',
    })

    const stream = sse(
      await app.request('/api/repos/repo1/stream?sinceSeq=0', {
        headers: { 'Last-Event-ID': String(first.seq) },
      }),
    )
    const [frame] = await stream.take(1)
    expect(frame?.event.seq).toBe(second.seq)

    await stream.close()
  })

  test('scopes both the replay and the live feed to one task', async () => {
    claim('bd-1')
    claim('bd-2')
    const stream = sse(await app.request('/api/repos/repo1/stream?taskId=bd-2'))

    const [replayed] = await stream.take(1)
    expect(replayed?.event.taskId).toBe('bd-2')

    store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
    const live = store.append('bd-2', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(live.seq)

    await stream.close()
  })

  test('pages a backlog longer than one store read', async () => {
    claim('bd-1')
    for (let i = 0; i < 600; i++) noise(i)

    const stream = sse(await app.request('/api/repos/repo1/stream'))
    const frames = await stream.take(601)
    expect(frames.map((f) => f.event.seq)).toEqual(Array.from({ length: 601 }, (_, i) => i + 1))

    await stream.close()
  })

  /**
   * An event appended while the backlog is still paging is both queued by the
   * subscription and picked up by the next page read. Only one copy may reach
   * the client.
   */
  test('does not duplicate an event appended mid replay', async () => {
    claim('bd-1')
    for (let i = 0; i < 600; i++) noise(i)

    // Append between the first and the second backlog page, so the event is
    // queued by the subscription and carried by the next page read as well.
    const read = store.events.bind(store)
    let injected = false
    store.events = ((opts: Parameters<Store['events']>[0]) => {
      const page = read(opts)
      if (!injected) {
        injected = true
        noise(600)
      }
      return page
    }) as Store['events']

    const stream = sse(await app.request('/api/repos/repo1/stream'))
    const frames = await stream.take(602)
    expect(frames.map((f) => f.event.seq)).toEqual(Array.from({ length: 602 }, (_, i) => i + 1))

    // The next frame has to be the new event, not a second copy of the one the
    // replay already delivered.
    const sentinel = noise(601)
    const [next] = await stream.take(1)
    expect(next?.event.seq).toBe(sentinel.seq)

    await stream.close()
  })

  test('releases the subscription when the client hangs up', async () => {
    claim('bd-1')
    const stream = sse(await app.request('/api/repos/repo1/stream'))
    await stream.take(1)
    expect(store.listenerCount).toBe(1)

    await stream.close()
    await settle()
    expect(store.listenerCount).toBe(0)
  })

  test('rejects a malformed sinceSeq', async () => {
    const res = await app.request('/api/repos/repo1/stream?sinceSeq=-1')
    expect(res.status).toBe(400)
  })
})
