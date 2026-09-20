import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredEvent } from '@amagi/core'
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

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const EVENTS: StoredEvent[] = [
  ev(1, 'am-1', { type: 'task.claimed', title: 'Fix the thing', tracker: 'beads' }),
  ev(2, 'am-1', { type: 'task.state', from: 'claimed', to: 'implementing' }),
  ev(3, 'am-1', {
    type: 'question.asked',
    questionId: 'q-1',
    question: 'Which registry?',
    options: ['npm', 'nexus'],
    gateRef: null,
  }),
]

describe('App', () => {
  test('renders the queue, opens a task, and shows its pending question', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.toString().includes('/api/stream')) return sseResponse(EVENTS)
      throw new Error(`unexpected fetch ${url}`)
    }) as unknown as typeof fetch

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('Fix the thing'))
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
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const href = url.toString()
      if (href.includes('/api/stream')) return sseResponse(EVENTS)
      if (href.endsWith('/api/tasks/am-1')) {
        return new Response(JSON.stringify({ token: 'secret' }), { status: 200 })
      }
      if (href.includes('/answer')) {
        posted.push({ url: href, body: JSON.parse(init?.body as string) })
        return new Response(JSON.stringify({}), { status: 200 })
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    const instance = render(createElement(App, { baseUrl: 'http://amagi.test' }))
    try {
      await waitFor(() => (instance.lastFrame() ?? '').includes('Fix the thing'))
      instance.stdin.write('\r')
      await waitFor(() => (instance.lastFrame() ?? '').includes('Which registry?'))

      instance.stdin.write('1')
      await waitFor(() => posted.length > 0)
      expect(posted[0]?.url).toBe('http://amagi.test/api/tasks/am-1/questions/q-1/answer')
      expect(posted[0]?.body).toEqual({ answer: 'npm', via: 'cli' })
    } finally {
      instance.unmount()
    }
  })
})
