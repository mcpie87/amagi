import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { hostStateHome } from './paths.ts'
import { pidAlive } from './process.ts'

const DEFAULT_WAIT_MS = 5 * 60 * 1000
const POLL_MS = 25
const ALLOCATOR_STALE_MS = 1000
const TICKET_HEARTBEAT_MS = 1000
/**
 * A live pid does not prove a waiter is still waiting: bun --watch reloads the
 * server in place, dropping its acquire loops but keeping the pid, and those
 * orphaned tickets would block the queue forever.
 */
const TICKET_STALE_MS = 10 * 1000

type SeatTicket = {
  id: string
  pid: number
  startedAt: number
  priority?: SeatRequestPriority
}

export type SeatRequestPriority = 'high' | 'low'

type SeatHolder = SeatTicket

export type SeatLockOptions = {
  /** Requests at a higher priority are served first; equal priorities stay FIFO. Defaults to high. */
  priority?: SeatRequestPriority
  /** How many holders may share this seat at once. Defaults to 1. */
  capacity?: number
  /** Maximum time to wait for this seat before rejecting. Defaults to five minutes, null waits indefinitely. */
  maxWaitMs?: number | null
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
  // A seat is a real subscription, so a dev amagi must queue behind the installed one.
  return envOverride ?? join(hostStateHome(), 'amagi', 'seat-locks')
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

function queuedTickets(dir: string, holderIds: Set<string>): SeatTicket[] {
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
    if (!pidAlive(ticket.pid) || (!holderIds.has(ticket.id) && ticketStale(path))) {
      rmSync(path, { force: true })
      continue
    }
    tickets.push({ ...ticket, priority: ticket.priority ?? 'high' })
  }
  return tickets.sort((a, b) => {
    const priority = (a.priority === 'low' ? 1 : 0) - (b.priority === 'low' ? 1 : 0)
    return priority || a.id.localeCompare(b.id)
  })
}

function ticketStale(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > TICKET_STALE_MS
  } catch {
    return true
  }
}

/** Slot 0 keeps the single-holder file name so builds without capacity still see it. */
function holderPath(dir: string, slot: number): string {
  return join(dir, slot === 0 ? 'holder.json' : `holder-${slot + 1}.json`)
}

function readHolder(dir: string, slot: number): SeatHolder | undefined {
  const path = holderPath(dir, slot)
  const holder = readJson<SeatHolder>(path)
  if (!holder || !Number.isInteger(holder.pid) || typeof holder.id !== 'string') {
    rmSync(path, { force: true })
    return undefined
  }
  if (!pidAlive(holder.pid)) {
    rmSync(path, { force: true })
    rmSync(ticketPath(dir, holder.id), { force: true })
    return undefined
  }
  return holder
}

/** Acquire one named seat across all processes sharing the same state home. */
export async function acquireSeat(seat: string, options: SeatLockOptions = {}): Promise<SeatLease> {
  if (!seat.trim()) throw new Error('seat name must not be empty')
  const capacity = options.capacity ?? 1
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('seat capacity must be a positive integer')
  }
  const dir = seatDir(seat, options.directory)
  const queueDir = join(dir, 'queue')
  mkdirSync(queueDir, { recursive: true })

  const maxWaitMs = options.maxWaitMs === undefined ? DEFAULT_WAIT_MS : options.maxWaitMs
  const deadline = maxWaitMs === null ? Number.POSITIVE_INFINITY : Date.now() + maxWaitMs
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
    const ticket: SeatTicket = {
      id: ticketId,
      pid: process.pid,
      startedAt: Date.now(),
      priority: options.priority ?? 'high',
    }
    writeFileSync(ticketPath(dir, ticketId), JSON.stringify(ticket), { flag: 'wx' })
    return ticketId
  })

  if (options.signal?.aborted) {
    rmSync(ticketPath(dir, id), { force: true })
    throw new SeatAcquireAbortedError(seat)
  }
  let waitingNotified = false
  let lastHeartbeat = Date.now()
  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      rmSync(ticketPath(dir, id), { force: true })
      throw new SeatAcquireAbortedError(seat)
    }
    if (Date.now() - lastHeartbeat >= TICKET_HEARTBEAT_MS) {
      lastHeartbeat = Date.now()
      const now = new Date()
      utimesSync(ticketPath(dir, id), now, now)
    }
    const holders = Array.from({ length: capacity }, (_, slot) => readHolder(dir, slot))
    const holderIds = new Set(holders.flatMap((holder) => (holder ? [holder.id] : [])))
    const waiting = queuedTickets(dir, holderIds).filter((ticket) => !holderIds.has(ticket.id))
    const freeSlots = holders.flatMap((holder, slot) => (holder ? [] : [slot]))
    // Every waiter sorts the same queue, so the n-th waiter alone claims the n-th free slot.
    const position = waiting.findIndex((ticket) => ticket.id === id)
    const ticket = waiting[position]
    const slot = freeSlots[position]
    if (ticket !== undefined && slot !== undefined) {
      const nextHolder: SeatHolder = { ...ticket, startedAt: Date.now() }
      writeAtomic(holderPath(dir, slot), nextHolder)
      return lease(seat, dir, slot, nextHolder)
    }
    if (!waitingNotified) {
      waitingNotified = true
      options.onWaiting?.(`waiting for seat ${seat}`)
    }
    await sleep(POLL_MS)
  }

  rmSync(ticketPath(dir, id), { force: true })
  if (maxWaitMs === null) throw new Error(`seat ${seat} wait ended unexpectedly`)
  throw new SeatWaitTimeoutError(seat, maxWaitMs)
}

function lease(seat: string, dir: string, slot: number, ticket: SeatTicket): SeatLease {
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
      writeAtomic(holderPath(dir, slot), currentTicket)
    },
    release(): void {
      if (released) return
      released = true
      const currentHolder = readJson<SeatHolder>(holderPath(dir, slot))
      if (currentHolder?.id === currentTicket.id) rmSync(holderPath(dir, slot), { force: true })
      rmSync(ticketPath(dir, currentTicket.id), { force: true })
    },
  }
}
