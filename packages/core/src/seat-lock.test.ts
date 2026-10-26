import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { childPids, killTree } from './process.ts'
import { acquireSeat } from './seat-lock.ts'

let directory: string

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

function tempDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), 'amagi-seat-lock-'))
  return directory
}

function seatPath(path: string, seat: string): string {
  return join(path, Buffer.from(seat, 'utf8').toString('hex'))
}

/** Takes the seat's allocator lock as another live process would. */
function holdAllocator(path: string, seat: string): string {
  const allocator = join(seatPath(path, seat), 'allocator')
  mkdirSync(allocator)
  writeFileSync(join(allocator, 'owner.json'), JSON.stringify({ pid: process.pid }))
  return allocator
}

describe('seat locks', () => {
  test('null wait limit acquires a seat without applying the default timeout', async () => {
    const lease = await acquireSeat('reviewer', { directory: tempDirectory(), maxWaitMs: null })
    lease.release()
  })

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

  test('lets up to capacity holders share a seat and queues the rest', async () => {
    const path = tempDirectory()
    const held = await Promise.all(
      [1, 2].map(() => acquireSeat('cap', { directory: path, capacity: 2 })),
    )
    let thirdHeld = false
    const third = acquireSeat('cap', { directory: path, capacity: 2 }).then((lease) => {
      thirdHeld = true
      return lease
    })

    await Bun.sleep(100)
    expect(thirdHeld).toBe(false)
    held[0]?.release()
    const lease = await third
    held[1]?.release()
    lease.release()
  })

  test('elects a holder only while it holds the allocator lock', async () => {
    const path = tempDirectory()
    const first = await acquireSeat('codex', { directory: path })
    let secondHeld = false
    const second = acquireSeat('codex', { directory: path }).then((lease) => {
      secondHeld = true
      return lease
    })
    await Bun.sleep(50)
    const allocator = holdAllocator(path, 'codex')

    first.release()
    await Bun.sleep(100)
    expect(secondHeld).toBe(false)
    rmSync(allocator, { recursive: true, force: true })
    ;(await second).release()
  })

  test('releases the holder only while it holds the allocator lock', async () => {
    const path = tempDirectory()
    const lease = await acquireSeat('codex', { directory: path })
    const holder = join(seatPath(path, 'codex'), 'holder.json')
    const allocator = holdAllocator(path, 'codex')

    lease.release()
    expect(existsSync(holder)).toBe(true)
    rmSync(allocator, { recursive: true, force: true })
    await Bun.sleep(100)
    expect(existsSync(holder)).toBe(false)
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

  test('serves higher priority requests first and keeps FIFO within each priority', async () => {
    const path = tempDirectory()
    const first = await acquireSeat('codex', { directory: path })
    const order: string[] = []
    const requests = [
      ['low-1', 'low'],
      ['high-1', 'high'],
      ['low-2', 'low'],
      ['high-2', 'high'],
    ] as const
    const waiters = requests.map(async ([name, priority]) => {
      const lease = await acquireSeat('codex', { directory: path, priority })
      order.push(name)
      lease.release()
    })

    await Bun.sleep(100)
    first.release()
    await Promise.all(waiters)
    expect(order).toEqual(['high-1', 'high-2', 'low-1', 'low-2'])
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

  test.skipIf(process.platform !== 'linux')(
    'reclaims a seat whose holder exited but was never reaped',
    async () => {
      const path = tempDirectory()
      const parent = Bun.spawn(['sh', '-c', 'sleep 30 & exec sleep 30'], { stdout: 'ignore' })
      try {
        let zombie: number | undefined
        for (let attempt = 0; attempt < 100; attempt++) {
          if (readFileSync(`/proc/${parent.pid}/comm`, 'utf8').trim() === 'sleep') {
            zombie = (await childPids(parent.pid))[0]
            if (zombie !== undefined) break
          }
          await Bun.sleep(10)
        }
        if (zombie === undefined) throw new Error('no unreaped child left behind')
        process.kill(zombie, 'SIGKILL')
        const stale = await acquireSeat('codex', { directory: path })
        stale.bind(zombie)
        const reclaimed = await acquireSeat('codex', { directory: path, maxWaitMs: 1000 })
        reclaimed.release()
      } finally {
        await killTree(parent.pid, { graceMs: 50 })
      }
    },
  )

  test('skips a ticket whose waiter stopped waiting while its process lives on', async () => {
    const path = tempDirectory()
    const queue = join(path, Buffer.from('codex', 'utf8').toString('hex'), 'queue')
    mkdirSync(queue, { recursive: true })
    const orphan = join(queue, '000000000000-orphan.json')
    writeFileSync(
      orphan,
      JSON.stringify({ id: '000000000000-orphan', pid: process.pid, startedAt: 0 }),
    )
    const past = new Date(Date.now() - 60_000)
    utimesSync(orphan, past, past)

    const lease = await acquireSeat('codex', { directory: path, maxWaitMs: 1000 })
    lease.release()
  })
})
