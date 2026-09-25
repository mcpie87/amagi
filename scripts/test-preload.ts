import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const seatLockDir = mkdtempSync(join(tmpdir(), 'amagi-test-seats-'))
process.env.AMAGI_SEAT_LOCK_DIR = seatLockDir

process.on('exit', () => {
  rmSync(seatLockDir, { recursive: true, force: true })
})
