import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.ts'
import type {
  GateRef,
  Tracker,
  TrackerCapabilities,
  TrackerStatus,
  TrackerTask,
} from './drivers/types.ts'
import type { Exec } from './exec.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'
import { holdTaskForChat } from './task-chat.ts'

class FakeTracker implements Tracker {
  readonly kind = 'fake'
  readonly leaseTtlMs = 300_000
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  status: TrackerStatus = 'open'
  readonly released: string[] = []

  private task(id: string): TrackerTask {
    return {
      id,
      title: 'fix it',
      description: '',
      status: this.status,
      priority: 2,
      type: 'bug',
      url: null,
    }
  }
  async ready(): Promise<TrackerTask[]> {
    return []
  }
  async claim(id?: string): Promise<TrackerTask | null> {
    if (id === undefined || this.status !== 'open') return null
    this.status = 'in_progress'
    return this.task(id)
  }
  async get(id: string): Promise<TrackerTask | null> {
    return this.task(id)
  }
  async createTask(): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async updateTask(): Promise<TrackerTask> {
    throw new Error('unsupported')
  }
  async heartbeat(): Promise<boolean> {
    return true
  }
  async comment(): Promise<void> {}
  async setStatus(): Promise<void> {}
  async release(id: string): Promise<void> {
    this.released.push(id)
    this.status = 'open'
  }
  async close(): Promise<void> {}
  async openGate(): Promise<GateRef> {
    return { id: 'g', advisory: true }
  }
  async gateResolved(): Promise<boolean> {
    return false
  }
  async resolveGate(): Promise<void> {}
}

const ok: Exec = async () => ({ exitCode: 0, stdout: '', stderr: '' })

let dir: string | null = null
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function setup() {
  const store = new Store(openDatabase(':memory:'))
  const tracker = new FakeTracker()
  const deps = {
    store,
    tracker,
    config: Config.parse({}),
    repoRoot: '/repo',
    repoName: 'repo',
    exec: ok,
  }
  return { store, tracker, deps }
}

describe('holdTaskForChat', () => {
  test('refuses a task a worker is running', async () => {
    const { store, deps } = setup()
    store.append('t1', { type: 'task.claimed', title: 'fix it', tracker: 'fake' })
    const hold = await holdTaskForChat(deps, 't1')
    expect(hold).toMatchObject({ ok: false, status: 409 })
  })

  test('re-claims a parked task into chatting on its surviving worktree', async () => {
    const { store, tracker, deps } = setup()
    dir = mkdtempSync(join(tmpdir(), 'amagi-task-chat-'))
    store.append('t1', { type: 'task.claimed', title: 'fix it', tracker: 'fake' })
    store.append('t1', { type: 'worktree.created', path: dir, branch: 'amagi/t1-fix-it' })
    store.append('t1', { type: 'task.state', from: 'claimed', to: 'needs_human' })
    tracker.status = 'in_progress'

    const hold = await holdTaskForChat(deps, 't1')

    expect(hold).toMatchObject({ ok: true, cwd: dir, branch: 'amagi/t1-fix-it' })
    expect(tracker.released).toEqual(['t1'])
    expect(tracker.status).toBe('in_progress')
    expect(store.task('t1')?.state).toBe('chatting')
  })
})
