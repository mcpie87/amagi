import { afterEach, describe, expect, test } from 'bun:test'
import { fetchTaskToken, submitAnswer } from './answer.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchTaskToken', () => {
  test('returns the token from the task detail endpoint', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://amagi.test/api/tasks/am-1')
      return new Response(JSON.stringify({ token: 'secret' }), { status: 200 })
    }) as unknown as typeof fetch

    expect(await fetchTaskToken('http://amagi.test', 'am-1')).toBe('secret')
  })

  test('returns null when the task is not found', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 404 })) as unknown as typeof fetch
    expect(await fetchTaskToken('http://amagi.test', 'am-1')).toBeNull()
  })
})

describe('submitAnswer', () => {
  test('posts the answer with the task token and via=cli', async () => {
    let capturedBody: unknown
    let capturedHeaders: Headers | undefined
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://amagi.test/api/tasks/am-1/questions/q-1/answer')
      capturedBody = JSON.parse(init?.body as string)
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await submitAnswer('http://amagi.test', 'am-1', 'q-1', 'secret', 'npm')
    expect(outcome).toEqual({ kind: 'ok' })
    expect(capturedBody).toEqual({ answer: 'npm', via: 'cli' })
    expect(capturedHeaders?.get('X-Amagi-Token')).toBe('secret')
  })

  test('surfaces the server error message on failure', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'already answered' }), {
        status: 409,
      })) as unknown as typeof fetch

    const outcome = await submitAnswer('http://amagi.test', 'am-1', 'q-1', 'secret', 'npm')
    expect(outcome).toEqual({ kind: 'error', message: 'already answered' })
  })
})
