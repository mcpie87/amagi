import { afterEach, expect, test } from 'bun:test'
import { harnessEnv } from './env.ts'

const original = process.env.GH_TOKEN

afterEach(() => {
  if (original === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = original
})

test('removes forge credentials while retaining task-scoped values', () => {
  process.env.GH_TOKEN = 'secret'
  const env: Record<string, string> = { ...harnessEnv(), AMAGI_TASK_TOKEN: 'task-token' }
  expect(env.GH_TOKEN).toBeUndefined()
  expect(env.AMAGI_TASK_TOKEN).toBe('task-token')
})
