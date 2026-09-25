import { afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const seatLockDir = mkdtempSync(join(tmpdir(), 'amagi-test-seats-'))
process.env.AMAGI_SEAT_LOCK_DIR = seatLockDir

function cleanupSeatLockDir() {
  rmSync(seatLockDir, { recursive: true, force: true })
}

afterAll(cleanupSeatLockDir)
process.on('exit', cleanupSeatLockDir)
