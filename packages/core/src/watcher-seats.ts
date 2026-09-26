import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateHome } from './paths.ts'
import { pidAlive } from './process.ts'

export type WatcherSeat = { pid: number; repo: string; watcher: string; seat: string }

function directory(): string {
  return join(stateHome(), 'amagi', 'watcher-seats')
}

function pathFor(pid: number): string {
  return join(directory(), `${pid}.json`)
}

/** Records a watcher agent only while it owns its credential seat. */
export function recordWatcherSeat(seat: WatcherSeat): void {
  try {
    mkdirSync(directory(), { recursive: true })
    writeFileSync(pathFor(seat.pid), JSON.stringify(seat))
  } catch (err) {
    console.warn(`watcher seats registry: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function removeWatcherSeat(pid: number): void {
  try {
    rmSync(pathFor(pid), { force: true })
  } catch (err) {
    console.warn(`watcher seats registry: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Reads live watcher seat holders and removes entries left by dead agents. */
export function loadWatcherSeats(): WatcherSeat[] {
  let files: string[]
  try {
    files = readdirSync(directory())
  } catch {
    return []
  }
  const seats: WatcherSeat[] = []
  for (const file of files) {
    const path = join(directory(), file)
    try {
      const seat = JSON.parse(readFileSync(path, 'utf8')) as WatcherSeat
      if (
        typeof seat.pid === 'number' &&
        typeof seat.repo === 'string' &&
        typeof seat.watcher === 'string' &&
        typeof seat.seat === 'string' &&
        pidAlive(seat.pid)
      ) {
        seats.push(seat)
      } else {
        rmSync(path, { force: true })
      }
    } catch {
      rmSync(path, { force: true })
    }
  }
  return seats
}
