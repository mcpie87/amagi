import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredEvent, TrackerTask } from '@amagi/core'
import { render } from 'ink-testing-library'
import { createElement } from 'react'
import { App } from './App.tsx'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function ev(seq: number, taskId: string | null, body: object): StoredEvent {
  return { seq, ts: 1_700_000_000_000, taskId, ...body } as StoredEvent
}

/** A one-shot SSE body: enough to prime the reducer, then the stream ends. */
function sseResponse(events: StoredEvent[]): Response {
  const text = events.map((e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const RUNNER = {
  name: 'repo1',
  available: true,
  capacity: 2,
  running: ['am-1'],
  startedAt: { 'am-1': 1_700_000_000_000 },
  resources: { 'am-1': { processes: 3, rssBytes: 123_456, cpuMs: 5_000 } },
  autoQueue: true,
  workers: [
    {
      repo: 'repo1',
      name: 'mention-watcher',
      lastRunAt: 1_700_000_000_000,
      ok: true,
      error: null,
      counters: [],
      detail: 'scanned 3 PRs',
      status: 'active',
      runs: 2,
      successes: 1,
      failures: 1,
      nextRunAt: 1_700_000_004_000,
      intervalMs: 4_000,
      log: [
        { ts: 1_700_000_000_000, message: 'run 2 started', level: 'info' },
        { ts: 1_700_000_001_000, message: 'PR #12: failed to read comments', level: 'error' },
      ],
    },
  ],
}

const READY: TrackerTask[] = [
  {
    id: 'am-9',
    title: 'Claimable chore',
    description: '',
    status: 'open',
    priority: 2,
    type: 'task',
    url: null,
  },
]

const EVENTS: StoredEvent[] = [
  ev(1, 'am-1', { type: 'task.claimed', title: 'Fix the thing', tracker: 'beads' }),
  ev(2, 'am-1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' }),
  ev(3, 'am-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' }),
  ev(4, 'am-1', {
    type: 'question.asked',
    questionId: 'q-1',
    question: 'Which registry?',
    options: ['npm', 'nexus'],
    gateRef: null,
  }),
]

function streamMock(events: StoredEvent[], extra?: (url: string, init?: RequestInit) => Response) {
  return (async (url: string, init?: RequestInit) => {
    const href = url.toString()
    if (href.includes('/api/repos/repo1/stream')) return sseResponse(events)
    if (href.endsWith('/api/repos/repo1/runner')) return json(RUNNER)
    if (href.endsWith('/api/repos/repo1/ready-queue')) return json(READY)
    if (extra !== undefined) {
      const response = extra(href, init)
      if (response !== undefined) return response
    }
    throw new Error(`unexpected fetch ${href}`)
  }) as unknown as typeof fetch
}

describe('App', () => {
  test('overview shows runner, watchers, claimable tasks, open PRs and needs attention', async () => {
    const events: StoredEvent[] = [
      ...EVENTS,
      ev(5, 'am-2', { type: 'task.claimed', title: 'Stuck task', tracker: 'beads' }),
      ev(6, 'am-2', { type: 'task.state', from: 'claimed', to: 'needs_human' }),
      ev(7, 'am-1', { type: 'pr.created', url: 'https://example.test/pr/1', number: 1 }),
      ev(8, 'am-1', { type: 'pr.status', mergeStatus: 'mergeable' }),
    ]
    globalThis.fetch = streamMock(events)

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test', repo: 'repo1' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('1/2 workers'))
      const frame = instance.lastFrame() ?? ''
      expect(frame).toContain('1/2 workers')
      expect(frame).toContain('auto-queue on')
      expect(frame).toContain('mention-watcher')
      expect(frame).toContain('Fix the thing')
      expect(frame).toContain('Claimable chore')
      expect(frame).toContain('mergeable')
      expect(frame).toContain('Stuck task')
      expect(frame).toContain('needs_human')
    } finally {
      instance.unmount()
    }
  })

  test('opens a watcher activity log and returns to the overview', async () => {
    globalThis.fetch = streamMock(EVENTS)

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test', repo: 'repo1' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('mention-watcher'))
      instance.stdin.write('\r')
      await waitFor(() => (instance.lastFrame() ?? '').includes('activity log'))
      const frame = instance.lastFrame() ?? ''
      expect(frame).toContain('2 runs')
      expect(frame).toContain('run 2 started')
      expect(frame).toContain('PR #12: failed to read comments')

      instance.stdin.write('\u001b')
      await waitFor(() => (instance.lastFrame() ?? '').includes('amagi overview'))
    } finally {
      instance.unmount()
    }
  })

  test('renders the queue, opens a task, and shows its pending question', async () => {
    globalThis.fetch = streamMock(EVENTS)

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test', repo: 'repo1' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('amagi overview'))
      instance.stdin.write('\t')
      await waitFor(() => (instance.lastFrame() ?? '').includes('Fix the thing'))
      expect(instance.lastFrame()).toContain('amagi queue')
      expect(instance.lastFrame()).toContain('implementing')

      instance.stdin.write('\r')
      await waitFor(() => (instance.lastFrame() ?? '').includes('Which registry?'))
      expect(instance.lastFrame()).toContain('1:npm')
      expect(instance.lastFrame()).toContain('am-1')

      instance.stdin.write('')
      await waitFor(() => (instance.lastFrame() ?? '').includes('amagi queue'))
    } finally {
      instance.unmount()
    }
  })

  test('answering an option posts it with the task token', async () => {
    const posted: { url: string; body: unknown }[] = []
    globalThis.fetch = streamMock(EVENTS, (href, init) => {
      if (href.endsWith('/api/repos/repo1/tasks/am-1')) {
        return new Response(JSON.stringify({ token: 'secret' }), { status: 200 })
      }
      if (href.includes('/answer')) {
        posted.push({ url: href, body: JSON.parse(init?.body as string) })
        return new Response(JSON.stringify({}), { status: 200 })
      }
      throw new Error(`unexpected fetch ${href}`)
    })

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test', repo: 'repo1' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('amagi overview'))
      instance.stdin.write('\t')
      await waitFor(() => (instance.lastFrame() ?? '').includes('Fix the thing'))
      instance.stdin.write('\r')
      await waitFor(() => (instance.lastFrame() ?? '').includes('Which registry?'))

      instance.stdin.write('1')
      await waitFor(() => posted.length > 0)
      expect(posted[0]?.url).toBe(
        'http://amagi.test/api/repos/repo1/tasks/am-1/questions/q-1/answer',
      )
      expect(posted[0]?.body).toEqual({ answer: 'npm', via: 'cli' })
    } finally {
      instance.unmount()
    }
  })
})
