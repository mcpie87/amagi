import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harnessEnv } from './env.ts'
import { shimDir } from './shim.ts'

const savedToken = process.env.GH_TOKEN
const savedXdg = process.env.XDG_CONFIG_HOME
const savedState = process.env.XDG_STATE_HOME
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amagi-env-'))
  process.env.XDG_STATE_HOME = home
  process.env.XDG_CONFIG_HOME = home
})

afterEach(() => {
  if (savedToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = savedToken
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(home, { recursive: true, force: true })
})

test('removes forge credentials while retaining task-scoped values', () => {
  process.env.GH_TOKEN = 'secret'
  const env = { ...harnessEnv(), AMAGI_TASK_TOKEN: 'task-token' } as Record<
    string,
    string | undefined
  >
  expect(env.GH_TOKEN).toBeUndefined()
  expect(env.AMAGI_TASK_TOKEN).toBe('task-token')
})

test('points gh and tea at empty Amagi-owned dirs so agents fail closed', () => {
  const env = harnessEnv()
  expect(env.GH_CONFIG_DIR).toContain(join(home, 'amagi', 'forge', 'agents', 'gh'))
  expect(env.XDG_CONFIG_HOME).toContain(join(home, 'amagi', 'forge', 'agents', 'xdg'))
  expect(env.XDG_CONFIG_HOME).not.toBe(home)
})

test('prepends the generated shim dir to PATH so every agent inherits the gate', () => {
  const env = harnessEnv()
  const dir = shimDir()
  expect(env.PATH).toStartWith(`${dir}:`)
  expect(existsSync(join(dir, 'git'))).toBe(true)
  expect(existsSync(join(dir, 'amagi'))).toBe(true)
})
