import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dropLiveRun,
  type LiveRun,
  loadLiveRuns,
  mergeLiveRuns,
  recordLiveRun,
  updateLiveRun,
} from './live-runs.ts'
import { killTree } from './process.ts'
import type { RunnerStatus } from './run-service.ts'

let dir: string
let path: string

const live = (): LiveRun => ({
  pid: process.pid,
  repoKey: 'repo1',
  repoName: 'repo1',
  taskId: 'bd-1',
  title: 'do the thing',
  harness: 'claude',
  model: null,
  effort: null,
  startedAt: 1720000000000,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-live-runs-'))
  path = join(dir, 'live-runs.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('live runs registry', () => {
  test('record, load, drop round-trip', () => {
    recordLiveRun(live(), path)
    expect(loadLiveRuns(path)).toEqual([live()])
    dropLiveRun('repo1', 'bd-1', path)
    expect(loadLiveRuns(path)).toEqual([])
  })

  test('recording the same repo+task replaces the prior record', () => {
    recordLiveRun(live(), path)
    recordLiveRun({ ...live(), pid: 1234, title: 'replacement' }, path)
    expect(loadLiveRuns(path)).toEqual([{ ...live(), pid: 1234, title: 'replacement' }])
  })

  test('a foreground run records when it is waiting for its seat', () => {
    recordLiveRun(live(), path)
    updateLiveRun('repo1', 'bd-1', { waitingOnSeat: true }, path)
    expect(loadLiveRuns(path)).toEqual([{ ...live(), waitingOnSeat: true }])
  })

  test('two tasks in one repo both stay recorded', () => {
    recordLiveRun(live(), path)
    recordLiveRun({ ...live(), taskId: 'bd-2' }, path)
    expect(loadLiveRuns(path).map((r) => r.taskId)).toEqual(['bd-1', 'bd-2'])
  })

  test('a missing or corrupt file loads as empty', () => {
    expect(loadLiveRuns(join(dir, 'nope.json'))).toEqual([])
    writeFileSync(path, 'not json')
    expect(loadLiveRuns(path)).toEqual([])
  })
})

describe('mergeLiveRuns', () => {
  const status = (): RunnerStatus => ({
    name: 'repo1',
    available: true,
    capacity: 2,
    busySeats: 0,
    totalSeats: 2,
    running: [],
    startedAt: {},
    resources: {},
    tasks: {},
    autoQueue: false,
  })

  test('adds a live run as a worker slot with identity and resources', async () => {
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore' })
    try {
      const merged = await mergeLiveRuns(status(), [{ ...live(), pid: proc.pid }])
      expect(merged.running).toEqual(['bd-1'])
      expect(merged.startedAt['bd-1']).toBe(1720000000000)
      expect(merged.tasks['bd-1']).toEqual({
        title: 'do the thing',
        harness: 'claude',
        model: null,
        effort: null,
        workerId: null,
        workerName: null,
        seat: 'claude',
        waitingOnSeat: false,
        adHoc: true,
      })
      expect(merged.resources['bd-1']).toBeDefined()
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })

  test('skips a task the server already owns', async () => {
    const merged = await mergeLiveRuns(
      {
        ...status(),
        running: ['bd-1'],
        tasks: { 'bd-1': { title: 'server', harness: 'x', model: null, effort: null } },
      },
      [live()],
    )
    expect(merged.running).toEqual(['bd-1'])
    expect(merged.tasks['bd-1']?.title).toBe('server')
  })

  test('keeps a configured foreground worker identity and seat-wait state', async () => {
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore' })
    try {
      const merged = await mergeLiveRuns(status(), [
        {
          ...live(),
          pid: proc.pid,
          workerId: 'worker-1',
          workerName: 'Claude worker',
          seat: 'claude-pro',
          waitingOnSeat: true,
        },
      ])
      expect(merged.tasks['bd-1']).toMatchObject({
        workerId: 'worker-1',
        workerName: 'Claude worker',
        seat: 'claude-pro',
        waitingOnSeat: true,
      })
      expect(merged.tasks['bd-1']?.adHoc).toBeUndefined()
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })

  test('drops a dead-pid record so a crashed CLI does not linger', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore' })
    await proc.exited
    recordLiveRun({ ...live(), pid: proc.pid }, path)
    const merged = await mergeLiveRuns(status(), loadLiveRuns(path), path)
    expect(merged.running).toEqual([])
    expect(loadLiveRuns(path)).toEqual([])
  })
})
