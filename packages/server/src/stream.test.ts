import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Store, type StoredEvent } from '@amagi/core'
import { type AppType, createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
let store: Store
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

type Frame = { id: string | undefined; name: string | undefined; event: StoredEvent }

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
            name: lines.find((l) => l.startsWith('event: '))?.slice(7),
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

  test('pushes idle notifications to connected clients without replaying old ones', async () => {
    store.append(null, { type: 'notify.idle', title: 'Queue is idle', body: 'No tasks remain' })
    const stream = sse(await app.request('/api/repos/repo1/stream'))
    const live = store.append(null, {
      type: 'notify.idle',
      title: 'Queue is idle',
      body: 'No tasks remain',
    })

    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(live.seq)
    expect(pushed?.event.type).toBe('notify.idle')
    await stream.close()
  })

  test('pushes desktop failure alerts without replaying old ones', async () => {
    store.append(null, {
      type: 'notify.failed',
      channel: 'libnotify',
      title: 'Task needs input',
      detail: 'notify-send unavailable',
    })
    const stream = sse(await app.request('/api/repos/repo1/stream'))
    const live = store.append(null, {
      type: 'notify.failed',
      channel: 'libnotify',
      title: 'Another task needs input',
      detail: 'notify-send unavailable',
    })

    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(live.seq)
    expect(pushed?.event.type).toBe('notify.failed')
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

  /** Another process sharing the database: its appends never reach this store's subscribers. */
  const otherProcess = () => new Store(store.db)

  test('slots events another process appended in before the next live one', async () => {
    const stream = sse(await app.request('/api/repos/repo1/stream?compact=1'))
    const [marker] = await stream.take(1)
    expect(marker?.name).toBe('replayed')

    const claimed = otherProcess().append('bd-1', {
      type: 'task.claimed',
      title: 'work on bd-1',
      tracker: 'beads',
    })
    const live = store.append('bd-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })

    const seqs = (await stream.take(2)).map((f) => f.event.seq)
    expect(seqs).toEqual([claimed.seq, live.seq])

    await stream.close()
  })

  test('a compact connect still delivers what another process appended as the replay ended', async () => {
    claim('bd-1')
    // Lands after the last backlog page was read, below the replayed mark.
    const read = store.events.bind(store)
    let late: StoredEvent | undefined
    store.events = ((opts: Parameters<Store['events']>[0]) => {
      const page = read(opts)
      late ??= otherProcess().append('bd-1', {
        type: 'task.state',
        from: 'claimed',
        to: 'worktree_ready',
      })
      return page
    }) as Store['events']

    const stream = sse(await app.request('/api/repos/repo1/stream?compact=1'))
    const [claimed, marker] = await stream.take(2)
    if (late === undefined) throw new Error('the other process never appended')
    expect(claimed?.event.type).toBe('task.claimed')
    expect(marker?.event as unknown).toBe(late.seq)

    const live = store.append('bd-1', {
      type: 'task.state',
      from: 'worktree_ready',
      to: 'implementing',
    })
    const seqs = (await stream.take(2)).map((f) => f.event.seq)
    expect(seqs).toEqual([late.seq, live.seq])

    await stream.close()
  })

  test("delivers another process's events while the server itself is quiet", async () => {
    claim('bd-1')
    const stream = sse(await app.request('/api/repos/repo1/stream?taskId=bd-1'))
    await stream.take(1)

    const state = otherProcess().append('bd-1', {
      type: 'task.state',
      from: 'claimed',
      to: 'worktree_ready',
    })
    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(state.seq)

    await stream.close()
  })

  test('rejects a malformed sinceSeq', async () => {
    const res = await app.request('/api/repos/repo1/stream?sinceSeq=-1')
    expect(res.status).toBe(400)
  })

  test('a compact replay leaves out agent log lines and marks where it ended', async () => {
    claim('bd-1')
    const line = (text: string) =>
      store.append('bd-1', {
        type: 'agent.stream',
        role: 'implement',
        event: { kind: 'text', text },
      })
    line('in the backlog')
    const head = line('also in the backlog')
    const stream = sse(await app.request('/api/repos/repo1/stream?compact=1'))

    const [claimed, marker] = await stream.take(2)
    expect(claimed?.event.type).toBe('task.claimed')
    expect(marker?.name).toBe('replayed')
    expect(marker?.event as unknown).toBe(head.seq)

    const live = line('live')
    const [pushed] = await stream.take(1)
    expect(pushed?.event.seq).toBe(live.seq)

    await stream.close()
  })

  test('a compact replay leaves out watcher history and check output, live events keep them', async () => {
    claim('bd-1')
    const checks = () =>
      store.append('bd-1', {
        type: 'checks.finished',
        ok: false,
        results: [{ command: 'just check', exitCode: 1, output: 'boom' }],
      })
    const watcherStart = (runId: string) =>
      store.append(null, {
        type: 'watcher.run.started',
        repo: 'repo1',
        name: 'mention-watcher',
        runId,
      })
    watcherStart('r1')
    checks()
    const stream = sse(await app.request('/api/repos/repo1/stream?compact=1'))

    const [claimed, replayedChecks, marker] = await stream.take(3)
    expect(claimed?.event.type).toBe('task.claimed')
    expect(replayedChecks?.event).toMatchObject({
      type: 'checks.finished',
      results: [{ command: 'just check', exitCode: 1, output: '' }],
    })
    expect(marker?.name).toBe('replayed')

    watcherStart('r2')
    checks()
    const [liveStart, liveChecks] = await stream.take(2)
    expect(liveStart?.event).toMatchObject({ type: 'watcher.run.started', runId: 'r2' })
    expect(liveChecks?.event).toMatchObject({ results: [{ output: 'boom' }] })

    await stream.close()
  })
})
