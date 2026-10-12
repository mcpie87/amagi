import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireUsageProbe, recordUsageHold, usageHoldKey } from './usage-hold.ts'

let stateRoot: string
let previousStateHome: string | undefined

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'amagi-usage-hold-'))
  previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = stateRoot
})

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true })
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousStateHome
})

describe('acquireUsageProbe', () => {
  test('serializes the expired hold probe and waits when the probe rearms it', async () => {
    const key = usageHoldKey('codex', 'gpt-5')
    recordUsageHold(key, 'codex', 'gpt-5', 'usage limit', Date.now() - 1)
    const release = await acquireUsageProbe(key)
    expect(release).toBeTypeOf('function')

    let cancelled = false
    let secondProbe = false
    const waiting = acquireUsageProbe(key, () => cancelled).then((lease) => {
      if (lease) {
        secondProbe = true
        lease()
      }
    })
    await Bun.sleep(30)
    recordUsageHold(key, 'codex', 'gpt-5', 'still limited', Date.now() + 60_000)
    release?.()
    await Bun.sleep(150)

    expect(secondProbe).toBe(false)
    cancelled = true
    await waiting
  })
})
