import { afterEach, describe, expect, test } from 'bun:test'
import { cacheHome, configHome, hostStateHome, stateHome } from './paths.ts'

const saved = { ...process.env }

afterEach(() => {
  for (const name of ['AMAGI_DEV_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

describe('AMAGI_DEV_HOME', () => {
  test('moves state and cache aside but keeps host state and config', () => {
    process.env.XDG_STATE_HOME = '/host/state'
    process.env.XDG_CACHE_HOME = '/host/cache'
    process.env.XDG_CONFIG_HOME = '/host/config'
    process.env.AMAGI_DEV_HOME = '/dev'
    expect(stateHome()).toBe('/dev/state')
    expect(cacheHome()).toBe('/dev/cache')
    expect(hostStateHome()).toBe('/host/state')
    expect(configHome()).toBe('/host/config')
  })

  test('is ignored unless absolute', () => {
    process.env.XDG_STATE_HOME = '/host/state'
    process.env.AMAGI_DEV_HOME = 'relative'
    expect(stateHome()).toBe('/host/state')
  })
})
