import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { stateHome } from './paths.ts'
import { pidAlive } from './process.ts'

const DEFAULT_WAIT_MS = 5 * 60 * 1000
const POLL_MS = 25
const ALLOCATOR_STALE_MS = 1000

type SeatTicket = {
  id: string
  pid: number
  startedAt: number
}

type SeatHolder = SeatTicket

export type SeatLockOptions = {
  /** Maximum time to wait for this seat before rejecting. Defaults to five minutes. */
  maxWaitMs?: number
  /** Called once when another holder or waiter is ahead. */
  onWaiting?: (message: string) => void
  /** Directory override for tests and isolated callers. */
  directory?: string
  /** Stops a queued caller without waiting for the current holder to exit. */
  signal?: AbortSignal
}

export class SeatAcquireAbortedError extends Error {
  constructor(seat: string) {
    super(`aborted while waiting for seat ${seat}`)
    this.name = 'SeatAcquireAbortedError'
  }
}

export type SeatLease = {
  readonly seat: string
  readonly startedAt: number
  /** Track the spawned agent instead of the process that requested the seat. */
  bind(pid: number): void
  release(): void
}

export class SeatWaitTimeoutError extends Error {
  constructor(seat: string, maxWaitMs: number) {
    super(`timed out waiting ${maxWaitMs}ms for seat ${seat}`)
    this.name = 'SeatWaitTimeoutError'
  }
}

function rootDir(override?: string): string {
  if (override) return override
  const envOverride = process.env.AMAGI_SEAT_LOCK_DIR
  return envOverride ?? join(stateHome(), 'amagi', 'seat-locks')
}

function seatDir(seat: string, directory?: string): string {
  const key = Buffer.from(seat, 'utf8').toString('hex')
  return join(rootDir(directory), key)
}

function ticketPath(dir: string, id: string): string {
  return join(dir, 'queue', `${id}.json`)
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { flag: 'wx' })
  renameSync(tmp, path)
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

async function withAllocator<T>(dir: string, deadline: number, work: () => T): Promise<T> {
  const lockDir = join(dir, 'allocator')
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir)
      try {
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }), {
          flag: 'wx',
        })
        return work()
      } finally {
        rmSync(lockDir, { recursive: true, force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    const owner = readJson<{ pid: number }>(join(lockDir, 'owner.json'))
    let stale = owner !== undefined && !pidAlive(owner.pid)
    if (owner === undefined) {
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > ALLOCATOR_STALE_MS
      } catch {
        stale = false
      }
    }
    if (stale) rmSync(lockDir, { recursive: true, force: true })
    await sleep(POLL_MS)
  }
  throw new Error('timed out allocating a seat queue ticket')
}

function queuedTickets(dir: string): SeatTicket[] {
  const queueDir = join(dir, 'queue')
  const tickets: SeatTicket[] = []
  for (const file of readdirSync(queueDir)) {
    if (!file.endsWith('.json')) continue
    const path = join(queueDir, file)
    const ticket = readJson<SeatTicket>(path)
    if (!ticket || typeof ticket.id !== 'string' || !Number.isInteger(ticket.pid)) {
      rmSync(path, { force: true })
      continue
    }
    if (!pidAlive(ticket.pid)) {
      rmSync(path, { force: true })
      continue
    }
    tickets.push(ticket)
  }
  return tickets.sort((a, b) => a.id.localeCompare(b.id))
}

function readHolder(dir: string): SeatHolder | undefined {
  const holderPath = join(dir, 'holder.json')
  const holder = readJson<SeatHolder>(holderPath)
  if (!holder || !Number.isInteger(holder.pid) || typeof holder.id !== 'string') {
    rmSync(holderPath, { force: true })
    return undefined
  }
  if (!pidAlive(holder.pid)) {
    rmSync(holderPath, { force: true })
    rmSync(ticketPath(dir, holder.id), { force: true })
    return undefined
  }
  return holder
}

/** Acquire one named seat across all processes sharing the same state home. */
export async function acquireSeat(seat: string, options: SeatLockOptions = {}): Promise<SeatLease> {
  if (!seat.trim()) throw new Error('seat name must not be empty')
  const dir = seatDir(seat, options.directory)
  const queueDir = join(dir, 'queue')
  mkdirSync(queueDir, { recursive: true })

  const maxWaitMs = options.maxWaitMs ?? DEFAULT_WAIT_MS
  const deadline = Date.now() + maxWaitMs
  const id = await withAllocator(dir, deadline, () => {
    const sequencePath = join(dir, 'sequence')
    let sequence = 0
    try {
      sequence = Number.parseInt(readFileSync(sequencePath, 'utf8'), 10) || 0
    } catch {
      // First ticket for this seat.
    }
    sequence += 1
    writeFileSync(sequencePath, String(sequence))
    const ticketId = `${String(sequence).padStart(12, '0')}-${randomUUID()}`
    const ticket: SeatTicket = { id: ticketId, pid: process.pid, startedAt: Date.now() }
    writeFileSync(ticketPath(dir, ticketId), JSON.stringify(ticket), { flag: 'wx' })
    return ticketId
  })

  if (options.signal?.aborted) {
    rmSync(ticketPath(dir, id), { force: true })
    throw new SeatAcquireAbortedError(seat)
  }
  let waitingNotified = false
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      rmSync(ticketPath(dir, id), { force: true })
      throw new SeatAcquireAbortedError(seat)
    }
    const holder = readHolder(dir)
    const queue = queuedTickets(dir)
    if (holder === undefined && queue[0]?.id === id) {
      const ticket = queue[0]
      if (!ticket) break
      const nextHolder: SeatHolder = { ...ticket, startedAt: Date.now() }
      writeAtomic(join(dir, 'holder.json'), nextHolder)
      return lease(seat, dir, nextHolder)
    }
    if (!waitingNotified) {
      waitingNotified = true
      options.onWaiting?.(`waiting for seat ${seat}`)
    }
    await sleep(POLL_MS)
  }

  rmSync(ticketPath(dir, id), { force: true })
  throw new SeatWaitTimeoutError(seat, maxWaitMs)
}

function lease(seat: string, dir: string, ticket: SeatTicket): SeatLease {
  let released = false
  let currentTicket = ticket
  return {
    seat,
    startedAt: ticket.startedAt,
    bind(pid: number): void {
      if (released) throw new Error(`seat ${seat} lease has already been released`)
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('agent pid must be a positive integer')
      currentTicket = { ...currentTicket, pid }
      writeAtomic(ticketPath(dir, currentTicket.id), currentTicket)
      writeAtomic(join(dir, 'holder.json'), currentTicket)
    },
    release(): void {
      if (released) return
      released = true
      const currentHolder = readJson<SeatHolder>(join(dir, 'holder.json'))
      if (currentHolder?.id === currentTicket.id) rmSync(join(dir, 'holder.json'), { force: true })
      rmSync(ticketPath(dir, currentTicket.id), { force: true })
    },
  }
}
