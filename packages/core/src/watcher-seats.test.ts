import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWatcherSeats, recordWatcherSeat, removeWatcherSeat } from './watcher-seats.ts'

const previousStateHome = process.env.XDG_STATE_HOME
let stateHome: string

afterEach(() => {
  rmSync(stateHome, { recursive: true, force: true })
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousStateHome
})

describe('watcher seat registry', () => {
  test('exposes a live watcher seat until its agent exits', () => {
    stateHome = mkdtempSync(join(tmpdir(), 'amagi-watcher-seats-'))
    process.env.XDG_STATE_HOME = stateHome
    const watcher = { pid: process.pid, repo: 'repo-a', watcher: 'mention-watcher', seat: 'claude' }

    recordWatcherSeat(watcher)
    expect(loadWatcherSeats()).toEqual([watcher])
    removeWatcherSeat(process.pid)
    expect(loadWatcherSeats()).toEqual([])
  })
})
