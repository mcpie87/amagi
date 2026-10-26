import { afterEach, describe, expect, test } from 'bun:test'
import { fetchOperatorSecret, submitAnswer } from './answer.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchOperatorSecret', () => {
  test('returns the secret from the session endpoint', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://amagi.test/api/session')
      return new Response(JSON.stringify({ secret: 'secret' }), { status: 200 })
    }) as unknown as typeof fetch

    expect(await fetchOperatorSecret('http://amagi.test')).toBe('secret')
  })

  test('returns null when the session endpoint fails', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 })) as unknown as typeof fetch
    expect(await fetchOperatorSecret('http://amagi.test')).toBeNull()
  })
})

describe('submitAnswer', () => {
  test('posts the answer with the operator secret and via=cli', async () => {
    let capturedBody: unknown
    let capturedHeaders: Headers | undefined
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://amagi.test/api/repos/repo1/tasks/am-1/questions/q-1/answer')
      capturedBody = JSON.parse(init?.body as string)
      capturedHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({}), { status: 200 })
    }) as unknown as typeof fetch

    const outcome = await submitAnswer('http://amagi.test', 'repo1', 'am-1', 'q-1', 'secret', 'npm')
    expect(outcome).toEqual({ kind: 'ok' })
    expect(capturedBody).toEqual({ answer: 'npm', via: 'cli' })
    expect(capturedHeaders?.get('X-Amagi-Secret')).toBe('secret')
  })

  test('surfaces the server error message on failure', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'already answered' }), {
        status: 409,
      })) as unknown as typeof fetch

    const outcome = await submitAnswer('http://amagi.test', 'repo1', 'am-1', 'q-1', 'secret', 'npm')
    expect(outcome).toEqual({ kind: 'error', message: 'already answered' })
  })
})
