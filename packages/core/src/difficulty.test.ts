import { describe, expect, test } from 'bun:test'
import { Config } from './config.ts'
import {
  claimEligible,
  claimGate,
  classifyDifficulty,
  implementModel,
  type MergeRecords,
  mergeRecord,
  mergeRecords,
  modelTier,
  parseDifficulty,
  requiredTier,
} from './difficulty.ts'
import type { Tracker, TrackerTask } from './drivers/types.ts'
import type { EventBody, StoredEvent } from './events.ts'
import type { makeHarness } from './factory.ts'
import { emptyProjection, project } from './project.ts'

const config = (over: Record<string, unknown> = {}) =>
  Config.parse({
    harness: { implement: { kind: 'claude', model: 'claude-haiku-4-5' } },
    difficulty: {
      enabled: true,
      modelTiers: { 'claude-haiku-4-5': 'fast', 'claude-sonnet-4-5': 'smart' },
    },
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

describe('modelTier', () => {
  test('uses the configured tier for a listed model', () => {
    expect(modelTier(config(), 'claude-sonnet-4-5')).toBe('smart')
  })

  test('unlisted and unknown models get the weakest tier', () => {
    expect(modelTier(config(), 'claude-haiku-4-5')).toBe('fast')
    expect(modelTier(config(), 'some-other-model')).toBe('fast')
    expect(modelTier(config(), null)).toBe('fast')
  })
})

describe('requiredTier', () => {
  test('high needs smart by default, unlisted levels need the weakest', () => {
    expect(requiredTier(config(), 'high')).toBe('smart')
    expect(requiredTier(config(), 'low')).toBe('fast')
    expect(requiredTier(config(), null)).toBe('fast')
  })
})

describe('claimGate', () => {
  test('disabled gating allows everything', () => {
    const cfg = config({ difficulty: { enabled: false } })
    expect(claimGate(cfg, task('high'), 'claude-haiku-4-5')).toEqual({ allowed: true })
  })

  test('a smart model may claim high difficulty', () => {
    const gate = claimGate(config(), task('high'), 'claude-sonnet-4-5')
    expect(gate).toEqual({ allowed: true })
  })

  test('a fast model is rejected from high difficulty with a clear reason', () => {
    const gate = claimGate(config(), task('high'), 'claude-haiku-4-5')
    expect(gate).toEqual({
      allowed: false,
      reason: 'claude-haiku-4-5 is only a fast model but high difficulty needs smart',
    })
  })

  test('low difficulty is claimable by any tier', () => {
    expect(claimGate(config(), task('low'), 'claude-haiku-4-5')).toEqual({ allowed: true })
  })

  test('a task without difficulty is never gated', () => {
    expect(claimGate(config(), task(null), 'claude-haiku-4-5')).toEqual({ allowed: true })
    expect(claimGate(config(), task(undefined), 'claude-haiku-4-5')).toEqual({ allowed: true })
  })

  test('an unlisted model counts as weakest, so high difficulty rejects it', () => {
    expect(claimGate(config(), task('high'), null).allowed).toBe(false)
    expect(claimGate(config(), task('low'), null)).toEqual({ allowed: true })
  })
})

describe('mergeRecords', () => {
  let seq = 0
  const ev = (taskId: string, body: EventBody): StoredEvent =>
    ({ seq: ++seq, ts: seq, taskId, ...body }) as StoredEvent
  const claimed = (id: string, difficulty: string | null): StoredEvent =>
    ev(id, { type: 'task.claimed', title: id, tracker: 'bd', difficulty })
  const implement = (id: string, model: string): StoredEvent =>
    ev(id, {
      type: 'agent.started',
      role: 'implement',
      harness: 'claude',
      model,
      effort: null,
      cwd: `/tmp/${id}`,
      resumed: false,
    })
  const pr = (id: string): StoredEvent =>
    ev(id, { type: 'pr.created', url: `https://x/${id}`, number: seq })
  const ended = (id: string, to: 'done' | 'abandoned' | 'no_pr' | 'needs_human'): StoredEvent =>
    ev(id, { type: 'task.state', from: 'claimed', to })
  const records = (events: StoredEvent[]): MergeRecords =>
    mergeRecords(Object.values(events.reduce(project, emptyProjection()).tasks), events)

  test('counts merges and failed PRs per model and difficulty, ignoring tasks without a PR', () => {
    const got = records([
      claimed('a', 'high'),
      implement('a', 'opus'),
      pr('a'),
      ended('a', 'done'),
      claimed('b', 'high'),
      implement('b', 'opus'),
      ended('b', 'abandoned'),
      claimed('c', 'high'),
      implement('c', 'opus'),
      ended('c', 'needs_human'),
      claimed('d', 'high'),
      implement('d', 'opus'),
      ended('d', 'no_pr'),
      claimed('e', 'high'),
      implement('e', 'opus'),
      ended('e', 'done'),
      claimed('f', 'low'),
      implement('f', 'opus'),
      pr('f'),
      ended('f', 'done'),
      claimed('g', null),
      implement('g', 'opus'),
      ended('g', 'abandoned'),
    ])
    expect(mergeRecord(got, 'opus', 'high')).toEqual({ merged: 1, failed: 2 })
    expect(mergeRecord(got, 'opus', 'low')).toEqual({ merged: 1, failed: 0 })
    expect(got.size).toBe(2)
  })

  test('credits the first implement agent of the attempt after the latest reset', () => {
    const got = records([
      claimed('a', 'high'),
      implement('a', 'haiku'),
      implement('a', 'sonnet'),
      ev('a', { type: 'task.reset' }),
      claimed('a', 'high'),
      implement('a', 'opus'),
      implement('a', 'sonnet'),
      pr('a'),
      ended('a', 'done'),
    ])
    expect([...got.keys()]).toEqual([JSON.stringify(['opus', 'high'])])
  })
})

describe('claimGate with merge records', () => {
  const records = (model: string, difficulty: string, merged: number, failed: number) =>
    new Map([[JSON.stringify([model, difficulty]), { merged, failed }]])

  test('a model that merges at a level may claim it whatever its tier', () => {
    const gate = claimGate(
      config(),
      task('high'),
      'claude-haiku-4-5',
      records('claude-haiku-4-5', 'high', 4, 1),
    )
    expect(gate).toEqual({ allowed: true })
  })

  test('a model below the merge rate floor is rejected whatever its tier', () => {
    const gate = claimGate(
      config(),
      task('low'),
      'claude-sonnet-4-5',
      records('claude-sonnet-4-5', 'low', 1, 4),
    )
    expect(gate).toEqual({
      allowed: false,
      reason: 'claude-sonnet-4-5 merged 1 of 5 low difficulty PRs, below the 50% floor',
    })
  })

  test('tiers decide until the model has minSamples outcomes, or when minSamples is 0', () => {
    const few = records('claude-haiku-4-5', 'high', 4, 0)
    expect(claimGate(config(), task('high'), 'claude-haiku-4-5', few).allowed).toBe(false)
    const off = config({
      difficulty: { enabled: true, modelTiers: { 'claude-haiku-4-5': 'fast' }, minSamples: 0 },
    })
    const many = records('claude-haiku-4-5', 'high', 9, 0)
    expect(claimGate(off, task('high'), 'claude-haiku-4-5', many).allowed).toBe(false)
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
    const claimed = await claimEligible(t, config(), 'claude-haiku-4-5', (skippedTask, reason) =>
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
    const claimed = await claimEligible(t, config(), 'claude-haiku-4-5', (tt, r) =>
      skipped.push(`${tt.id}:${r}`),
    )
    expect(claimed).toBeNull()
    expect(skipped).toHaveLength(2)
    expect(t.claimedIds).toEqual([])
  })

  test('falls back to the tracker claim when gating is disabled', async () => {
    const t = tracker([task('high')])
    const cfg = config({ difficulty: { enabled: false } })
    const claimed = await claimEligible(t, cfg, 'claude-haiku-4-5')
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

describe('implementModel', () => {
  test('reads the model from the implement harness config', () => {
    expect(implementModel(config())).toBe('claude-haiku-4-5')
    expect(implementModel(config({ harness: { implement: { kind: 'claude' } } }))).toBeNull()
  })
})
