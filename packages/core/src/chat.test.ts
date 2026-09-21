import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AsyncQueue } from './async-queue.ts'
import { ChatService } from './chat.ts'
import { Config } from './config.ts'
import type { AgentOutcome, AgentProcess, AgentStartOptions, Harness } from './drivers/types.ts'
import type { AgentEvent, StoredEvent } from './events.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'

const CONFIG = Config.parse({})

class FakeHarness implements Harness {
  readonly kind = 'fake'
  readonly calls: { resumeFrom: string | null; prompt: string; cwd: string }[] = []
  events: AgentEvent[] = []
  outcome: Partial<AgentOutcome> = {}
  sessionId = 'sess-1'
  /** When false, each resume parks its done promise here instead of resolving. */
  autoResolve = true
  readonly pending: (() => void)[] = []

  start(opts: AgentStartOptions): AgentProcess {
    return this.run(null, opts)
  }
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.run(sessionId, opts)
  }
  async listModels(): Promise<string[]> {
    return []
  }
  async listEfforts(): Promise<string[]> {
    return []
  }

  private run(resumeFrom: string | null, opts: AgentStartOptions): AgentProcess {
    this.calls.push({ resumeFrom, prompt: opts.prompt, cwd: opts.cwd })
    const queue = new AsyncQueue<AgentEvent>()
    for (const e of this.events) queue.push(e)
    const outcome: AgentOutcome = {
      exitCode: 0,
      ok: true,
      sessionId: this.sessionId,
      summary: 'answered',
      usage: null,
      stderr: '',
      ...this.outcome,
    }
    let resolveDone!: (o: AgentOutcome) => void
    const done = new Promise<AgentOutcome>((resolve) => {
      resolveDone = resolve
    })
    if (this.autoResolve) {
      queue.close()
      resolveDone(outcome)
    } else {
      this.pending.push(() => {
        queue.close()
        resolveDone(outcome)
      })
    }
    return {
      pid: -1,
      events: () => queue,
      done,
      kill: async () => {},
      model: null,
      effort: null,
    }
  }
}

/** Seeds a no_pr task with a summary, worktree and session, unless overridden. */
function seedNoPr(
  store: Store,
  id: string,
  opts: { noReason?: boolean; noSession?: boolean } = {},
): void {
  store.append(id, { type: 'task.claimed', title: 't', tracker: 'beads' })
  store.append(id, { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
  store.append(id, { type: 'worktree.created', path: '/tmp/wt', branch: 'amagi/x' })
  store.append(id, { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  if (!opts.noSession) {
    store.append(id, { type: 'agent.exited', role: 'implement', exitCode: 0, sessionId: 'sess-1' })
  }
  store.append(id, {
    type: 'task.state',
    from: 'implementing',
    to: 'no_pr',
    ...(opts.noReason ? {} : { reason: 'no changes' }),
  })
}

const waitFor = async (pred: () => boolean, timeout = 2000): Promise<void> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (pred()) return
    await Bun.sleep(5)
  }
  throw new Error('timed out waiting for the chat run to finish')
}

let store: Store
let harness: FakeHarness
let chat: ChatService

beforeEach(() => {
  store = new Store(openDatabase(':memory:'))
  harness = new FakeHarness()
  chat = new ChatService({ store, harness, config: CONFIG })
})

afterEach(() => {
  store.close()
})

describe('ChatService.send', () => {
  test('resumes the recorded session on the worktree and streams the answer as events', async () => {
    harness.events = [
      { kind: 'text', text: 'the' },
      { kind: 'text', text: ' answer\n' },
    ]
    seedNoPr(store, 'bd-1')

    expect(chat.send('bd-1', 'why no pr?')).toEqual({ ok: true })

    await waitFor(() =>
      store.events({ taskId: 'bd-1' }).some((e) => e.type === 'agent.exited' && e.role === 'chat'),
    )

    const events = store.events({ taskId: 'bd-1' })
    expect(events.some((e) => e.type === 'chat.message' && e.text === 'why no pr?')).toBe(true)
    const started = events.find((e) => e.type === 'agent.started' && e.role === 'chat')
    expect(started).toMatchObject({ role: 'chat', cwd: '/tmp/wt', resumed: true })
    const texts = events
      .filter(
        (e): e is Extract<StoredEvent, { type: 'agent.stream' }> & { event: { kind: 'text' } } =>
          e.type === 'agent.stream' && e.role === 'chat' && e.event.kind === 'text',
      )
      .map((e) => e.event.text)
      .join('')
    expect(texts).toBe('the answer\n')
    expect(harness.calls).toEqual([{ resumeFrom: 'sess-1', prompt: 'why no pr?', cwd: '/tmp/wt' }])
  })

  test('updates the session id when the resumed run reports a new one', async () => {
    harness.sessionId = 'sess-2'
    seedNoPr(store, 'bd-1')

    expect(chat.send('bd-1', 'more')).toEqual({ ok: true })
    await waitFor(() => store.task('bd-1')?.sessionId === 'sess-2')
  })

  test('refuses a task that is not in no_pr state', async () => {
    store.append('bd-1', { type: 'task.claimed', title: 't', tracker: 'beads' })
    expect(chat.send('bd-1', 'hi')).toMatchObject({ ok: false, status: 409 })
    expect(store.events({ taskId: 'bd-1' }).some((e) => e.type === 'chat.message')).toBe(false)
  })

  test('refuses a no_pr task without a summary', async () => {
    seedNoPr(store, 'bd-1', { noReason: true })
    expect(chat.send('bd-1', 'hi')).toMatchObject({ ok: false, status: 409 })
  })

  test('refuses a no_pr task without a session to resume', async () => {
    seedNoPr(store, 'bd-1', { noSession: true })
    expect(chat.send('bd-1', 'hi')).toMatchObject({ ok: false, status: 409 })
  })

  test('refuses an unknown task', async () => {
    expect(chat.send('nope', 'hi')).toMatchObject({ ok: false, status: 404 })
  })

  test('serializes messages while a run is in flight', async () => {
    harness.autoResolve = false
    seedNoPr(store, 'bd-1')
    expect(chat.send('bd-1', 'first')).toEqual({ ok: true })
    expect(chat.send('bd-1', 'second')).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringMatching(/already responding/),
    })
    harness.pending[0]?.()
    await waitFor(() => chat.send('bd-1', 'third').ok === true)
  })

  test('records a failure as a task error without dropping the run', async () => {
    harness.outcome = { ok: false, exitCode: 1, stderr: 'boom' }
    seedNoPr(store, 'bd-1')
    expect(chat.send('bd-1', 'hi')).toEqual({ ok: true })
    await waitFor(() =>
      store.events({ taskId: 'bd-1' }).some((e) => e.type === 'agent.exited' && e.role === 'chat'),
    )
    const events = store.events({ taskId: 'bd-1' })
    expect(events.some((e) => e.type === 'error' && e.message === 'chat agent failed: boom')).toBe(
      true,
    )
  })
})
