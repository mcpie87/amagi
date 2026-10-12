import { describe, expect, test } from 'bun:test'
import { Config } from './config.ts'
import { claimEligible, claimGate, classifyDifficulty, parseDifficulty } from './difficulty.ts'
import type { Tracker, TrackerTask } from './drivers/types.ts'
import type { makeHarness } from './factory.ts'

const config = (over: Record<string, unknown> = {}) =>
  Config.parse({
    harness: { implement: { kind: 'claude', model: 'claude-haiku-4-5' } },
    difficulty: { enabled: true },
    ...over,
  })

const task = (difficulty: string | null | undefined): TrackerTask => ({
  id: 'bd-1',
  title: 'T',
  description: '',
  status: 'open',
  priority: null,
  type: null,
  url: null,
  ...(difficulty === undefined || difficulty === null ? {} : { difficulty }),
})

const easyOnly = { name: 'Haiku 1', difficulties: ['low', 'medium'] }

describe('claimGate', () => {
  test('disabled gating allows everything', () => {
    const cfg = config({ difficulty: { enabled: false } })
    expect(claimGate(cfg, task('high'), easyOnly)).toEqual({ allowed: true })
  })

  test('a worker may claim the levels it lists', () => {
    expect(claimGate(config(), task('low'), easyOnly)).toEqual({ allowed: true })
    expect(claimGate(config(), task('medium'), easyOnly)).toEqual({ allowed: true })
  })

  test('a worker is rejected from a level it does not list, with a clear reason', () => {
    expect(claimGate(config(), task('high'), easyOnly)).toEqual({
      allowed: false,
      reason: 'Haiku 1 does not take high difficulty tasks',
    })
    expect(claimGate(config(), task('low'), { name: 'Idle', difficulties: [] }).allowed).toBe(false)
  })

  test('a task without difficulty is never gated', () => {
    expect(claimGate(config(), task(null), easyOnly)).toEqual({ allowed: true })
    expect(claimGate(config(), task(undefined), easyOnly)).toEqual({ allowed: true })
  })

  test('a worker without a list, or no worker at all, takes every level', () => {
    expect(claimGate(config(), task('high'), { name: 'Opus 1' })).toEqual({ allowed: true })
    expect(claimGate(config(), task('high'), null)).toEqual({ allowed: true })
  })
})

describe('parseDifficulty', () => {
  const levels = ['low', 'medium', 'high']
  test('reads the level out of the reply', () => {
    expect(parseDifficulty('high', levels)).toBe('high')
    expect(parseDifficulty('  Medium  ', levels)).toBe('medium')
  })
  test('returns null for an unrecognised reply', () => {
    expect(parseDifficulty('maybe', levels)).toBeNull()
    expect(parseDifficulty('', levels)).toBeNull()
  })
})

describe('claimEligible', () => {
  const tracker = (queue: TrackerTask[]): Tracker & { claimedIds: string[] } => {
    const claimedIds: string[] = []
    return {
      kind: 'fake',
      leaseTtlMs: 60_000,
      capabilities: { create: true, edit: true, dependencies: true },
      claimedIds,
      async ready() {
        return queue
      },
      async claim(id?: string) {
        const hit = id === undefined ? queue[0] : queue.find((t) => t.id === id)
        if (hit === undefined) return null
        claimedIds.push(hit.id)
        return hit
      },
      async get() {
        return null
      },
      async createTask() {
        return task(null)
      },
      async updateTask() {
        return task(null)
      },
      async heartbeat() {
        return true
      },
      async comment() {},
      async setStatus() {},
      async release() {},
      async close() {},
      async openGate() {
        return { id: 'g', advisory: false }
      },
      async gateResolved() {
        return true
      },
      async resolveGate() {},
    }
  }

  test('skips gated tasks and claims the first eligible one', async () => {
    const t = tracker([
      { ...task('high'), id: 't1' },
      { ...task('low'), id: 't2' },
      { ...task('high'), id: 't3' },
    ])
    const skipped: string[] = []
    const claimed = await claimEligible(t, config(), easyOnly, (skippedTask, reason) =>
      skipped.push(`${skippedTask.id}:${reason}`),
    )
    expect(claimed?.id).toBe('t2')
    // The high tasks are skipped and reported, the low one is claimed.
    expect(skipped.map((s) => s.split(':')[0])).toEqual(['t1'])
    expect(t.claimedIds).toEqual(['t2'])
  })

  test('returns null and reports all when nothing is eligible', async () => {
    const t = tracker([
      { ...task('high'), id: 't1' },
      { ...task('high'), id: 't2' },
    ])
    const skipped: string[] = []
    const claimed = await claimEligible(t, config(), easyOnly, (tt, r) =>
      skipped.push(`${tt.id}:${r}`),
    )
    expect(claimed).toBeNull()
    expect(skipped).toHaveLength(2)
    expect(t.claimedIds).toEqual([])
  })

  test('falls back to the tracker claim when gating is disabled', async () => {
    const t = tracker([task('high')])
    const cfg = config({ difficulty: { enabled: false } })
    const claimed = await claimEligible(t, cfg, easyOnly)
    expect(claimed?.id).toBe('bd-1')
    expect(t.claimedIds).toEqual(['bd-1'])
  })
})

describe('classifyDifficulty', () => {
  const fakeHarness = (summary: string, ok = true) => {
    const mk = () =>
      ({
        kind: 'fake',
        start() {
          return {
            pid: -1,
            async *events() {},
            done: Promise.resolve({
              exitCode: ok ? 0 : 1,
              ok,
              sessionId: null,
              summary,
              usage: null,
              stderr: '',
            }),
            kill: async () => {},
            model: null,
            effort: null,
          }
        },
        resume() {
          throw new Error('no resume in difficulty tests')
        },
        async listModels() {
          return []
        },
        async listEfforts() {
          return []
        },
      }) satisfies ReturnType<typeof makeHarness>
    return mk
  }

  test('classifies from the agent summary', async () => {
    const cfg = config()
    const level = await classifyDifficulty(
      'Ship the board',
      'Make it writable',
      cfg,
      fakeHarness('high') as typeof makeHarness,
    )
    expect(level).toBe('high')
  })

  test('a failed harness run yields null instead of throwing', async () => {
    const cfg = config()
    const level = await classifyDifficulty(
      'Ship the board',
      'Make it writable',
      cfg,
      fakeHarness('medium', false) as typeof makeHarness,
    )
    expect(level).toBeNull()
  })

  test('an unrecognised reply yields null', async () => {
    const cfg = config()
    const level = await classifyDifficulty(
      'Ship the board',
      'Make it writable',
      cfg,
      fakeHarness('maybe') as typeof makeHarness,
    )
    expect(level).toBeNull()
  })
})
