import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateHome } from './paths.ts'
import { pidAlive } from './process.ts'

export type UsageHold = {
  harness: string
  model: string
  expiresAt: number
  reason: string
}

export function usageHoldKey(harness: string, model: string | null, seat?: string): string {
  return `${harness}:${model ?? `seat:${seat ?? harness}`}`
}

function paths(key: string): { hold: string; probe: string } {
  const dir = join(stateHome(), 'amagi', 'usage-holds')
  const id = Buffer.from(key).toString('hex')
  return { hold: join(dir, `${id}.json`), probe: join(dir, `${id}.probe`) }
}

export function readUsageHold(key: string, now = Date.now()): UsageHold | null {
  const path = paths(key).hold
  try {
    const hold = JSON.parse(readFileSync(path, 'utf8')) as UsageHold
    return Number.isFinite(hold.expiresAt) && hold.expiresAt > now ? hold : null
  } catch {
    return null
  }
}

export function recordUsageHold(
  key: string,
  harness: string,
  model: string | null,
  reason: string,
  expiresAt: number,
): UsageHold {
  const hold = { harness, model: model ?? 'unknown', expiresAt, reason }
  const path = paths(key).hold
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(hold), { flag: 'wx' })
  renameSync(tmp, path)
  return hold
}

export function clearUsageHold(key: string): void {
  rmSync(paths(key).hold, { force: true })
}

/** Waits out an active hold and serializes the single post-expiry probe. */
export async function acquireUsageProbe(
  key: string,
  cancelled: () => boolean = () => false,
): Promise<(() => void) | null> {
  const { hold: holdPath, probe } = paths(key)
  for (;;) {
    if (cancelled()) return null
    const hold = readRawHold(holdPath)
    if (hold === null) return null
    if (hold.expiresAt > Date.now()) {
      await Bun.sleep(Math.min(100, hold.expiresAt - Date.now()))
      continue
    }
    try {
      mkdirSync(dirname(probe), { recursive: true })
      writeFileSync(probe, JSON.stringify({ pid: process.pid }), { flag: 'wx' })
      return () => rmSync(probe, { force: true })
    } catch {
      try {
        const owner = JSON.parse(readFileSync(probe, 'utf8')) as { pid?: number }
        if (!Number.isInteger(owner.pid) || !pidAlive(owner.pid as number))
          rmSync(probe, { force: true })
      } catch {
        rmSync(probe, { force: true })
      }
      await Bun.sleep(100)
    }
  }
}

function readRawHold(path: string): UsageHold | null {
  try {
    const hold = JSON.parse(readFileSync(path, 'utf8')) as UsageHold
    return Number.isFinite(hold.expiresAt) ? hold : null
  } catch {
    return null
  }
}
