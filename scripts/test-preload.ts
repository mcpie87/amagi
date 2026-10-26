import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests point XDG_* at temp dirs; a dev amagi's AMAGI_DEV_HOME would override them.
delete process.env.AMAGI_DEV_HOME

const seatLockDir = mkdtempSync(join(tmpdir(), 'amagi-test-seats-'))
process.env.AMAGI_SEAT_LOCK_DIR = seatLockDir

// A running amagi on this host writes live state (watcher seats, stores) under the real XDG_STATE_HOME.
const stateDir = mkdtempSync(join(tmpdir(), 'amagi-test-state-'))
process.env.XDG_STATE_HOME = stateDir

process.on('exit', () => {
  rmSync(seatLockDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})
