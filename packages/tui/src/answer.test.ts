import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchOperatorSecret, submitAnswer } from './answer.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchOperatorSecret', () => {
  test('reads the local state only for the matching loopback server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-session-test-'))
    const previous = process.env.AMAGI_DEV_HOME
    process.env.AMAGI_DEV_HOME = dir
    try {
      mkdirSync(join(dir, 'state', 'amagi'), { recursive: true })
      writeFileSync(
        join(dir, 'state', 'amagi', 'operator-session.json'),
        JSON.stringify({ secret: 'secret', port: 7777 }),
      )
      expect(await fetchOperatorSecret('http://localhost:7777')).toBe('secret')
      expect(await fetchOperatorSecret('http://localhost:7778')).toBeNull()
      expect(await fetchOperatorSecret('http://evil.test:7777')).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.AMAGI_DEV_HOME
      else process.env.AMAGI_DEV_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
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
