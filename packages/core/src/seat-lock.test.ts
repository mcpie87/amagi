import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSeat } from './seat-lock.ts'

let directory: string

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), 'amagi-seat-lock-'))
  return directory
}

describe('seat locks', () => {
  test('serializes acquisitions and notifies waiters', async () => {
    const path = tempDirectory()
    const first = await acquireSeat('claude', { directory: path })
    let waitingMessage: string | undefined
    const secondPromise = acquireSeat('claude', {
      directory: path,
      onWaiting: (message) => (waitingMessage = message),
    })

    await Bun.sleep(50)
    expect(waitingMessage).toBe('waiting for seat claude')
    first.release()
    const second = await secondPromise
    second.release()
  })

  test('serves queued callers in arrival order', async () => {
    const path = tempDirectory()
    const first = await acquireSeat('codex', { directory: path })
    const order: number[] = []
    const waiters = [1, 2, 3].map(async (n) => {
      const lease = await acquireSeat('codex', { directory: path })
      order.push(n)
      await Bun.sleep(10)
      lease.release()
    })

    await Bun.sleep(100)
    first.release()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })

  test('allows different seat names concurrently', async () => {
    const path = tempDirectory()
    const first = await acquireSeat('claude', { directory: path })
    const second = await acquireSeat('codex', { directory: path, maxWaitMs: 100 })
    second.release()
    first.release()
  })

  test('fails clearly when the wait limit expires', async () => {
    const path = tempDirectory()
    const holder = await acquireSeat('opencode', { directory: path })
    await expect(acquireSeat('opencode', { directory: path, maxWaitMs: 50 })).rejects.toThrow(
      'timed out waiting 50ms for seat opencode',
    )
    holder.release()
  })

  test('reclaims a seat held by a killed process', async () => {
    const path = tempDirectory()
    const modulePath = new URL('./seat-lock.ts', import.meta.url).pathname
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { acquireSeat } from ${JSON.stringify(modulePath)};
         const lease = await acquireSeat('claude', { directory: ${JSON.stringify(path)} });
         lease.bind(process.pid);
         console.log('ready');
         setInterval(() => {}, 1000);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const reader = child.stdout.getReader()
    let output = ''
    while (!output.includes('ready')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('seat holder exited before acquiring its seat')
      output += new TextDecoder().decode(chunk.value)
    }

    child.kill('SIGKILL')
    await child.exited
    const reclaimed = await acquireSeat('claude', { directory: path, maxWaitMs: 1000 })
    reclaimed.release()
  })
})
