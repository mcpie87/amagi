import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests point XDG_* at temp dirs; a dev amagi's AMAGI_DEV_HOME would override them.
delete process.env.AMAGI_DEV_HOME

const seatLockDir = mkdtempSync(join(tmpdir(), 'amagi-test-seats-'))
process.env.AMAGI_SEAT_LOCK_DIR = seatLockDir

process.on('exit', () => {
  rmSync(seatLockDir, { recursive: true, force: true })
})
