import { expect, test } from 'bun:test'
import { Config } from './config.ts'
import { LibnotifyNotifier, makeNotifiers, NtfyNotifier } from './notify.ts'

const exec =
  (result: { exitCode: number; stdout?: string; stderr?: string }) =>
  async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
    exitCode: result.exitCode,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  })

const missingBinary = async (): Promise<never> => {
  throw new Error('spawn notify-send ENOENT')
}

const config = (over: Record<string, unknown> = {}): Config => {
  const parsed = Config.safeParse(over)
  if (!parsed.success) throw new Error('bad config')
  return parsed.data
}

test('libnotify degrades to a warning when notify-send is missing', async () => {
  const notifier = new LibnotifyNotifier(missingBinary)
  const warnings: unknown[] = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    await notifier.notify('title', 'body')
  } finally {
    console.warn = original
  }
  expect(warnings.length).toBeGreaterThan(0)
  expect(String(warnings[0])).toContain('notify-send unavailable')
})

test('libnotify warns on a non-zero exit', async () => {
  const notifier = new LibnotifyNotifier(exec({ exitCode: 1, stderr: 'bus' }))
  const warnings: unknown[] = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args)
  try {
    await notifier.notify('title', 'body')
  } finally {
    console.warn = original
  }
  expect(warnings.length).toBeGreaterThan(0)
  expect(String(warnings[0])).toContain('exited 1')
})

test('ntfy posts the title and body to the topic url', async () => {
  const hit: { url: string; title: string; body: string }[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    hit.push({
      url: String(input),
      title: new Headers(init?.headers).get('title') ?? '',
      body: String(init?.body ?? ''),
    })
    return new Response('ok', { status: 200 })
  }) as unknown as typeof fetch
  try {
    await new NtfyNotifier('amagi', 'https://ntfy.example').notify('title', 'body')
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(hit[0]?.url).toBe('https://ntfy.example/amagi')
  expect(hit[0]?.title).toBe('title')
  expect(hit[0]?.body).toBe('body')
})

test('ntfy surfaces a non-2xx as an error', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch
  try {
    await expect(new NtfyNotifier('amagi').notify('title', 'body')).rejects.toThrow(/400/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('makeNotifiers respects config.notify flags', () => {
  const all = makeNotifiers(config({ notify: { desktop: true, ntfyTopic: 'amagi' } }))
  expect(all.map((n) => n.kind).sort()).toEqual(['libnotify', 'ntfy'])

  const off = makeNotifiers(config({ notify: { desktop: false, ntfyTopic: null } }))
  expect(off).toEqual([])
})
