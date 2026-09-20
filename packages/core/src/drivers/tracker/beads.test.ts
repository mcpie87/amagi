import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../../exec.ts'
import { BeadsTracker, gateTitle } from './beads.ts'

/** Recorded from bd 1.3.0. */
const READY_JSON = `[
  {
    "id": "tst-lmc",
    "title": "Add SSE endpoint to the server",
    "description": "Stream events to the dashboard",
    "status": "open",
    "priority": 1,
    "issue_type": "task",
    "owner": "someone@example.com",
    "created_at": "2026-09-20T14:02:53Z",
    "created_by": "Someone",
    "updated_at": "2026-09-20T14:02:53Z",
    "dependency_count": 0,
    "dependent_count": 0,
    "comment_count": 0
  }
]`

const CLAIMED_JSON = `[
  {
    "id": "tst-lmc",
    "title": "Add SSE endpoint to the server",
    "description": "Stream events to the dashboard",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "Someone",
    "created_at": "2026-09-20T14:02:53Z",
    "updated_at": "2026-09-20T14:03:00Z",
    "started_at": "2026-09-20T14:03:00Z",
    "lease_expires_at": "2026-09-20T14:08:00Z",
    "heartbeat_at": "2026-09-20T14:03:00Z",
    "dependency_count": 0,
    "dependent_count": 0,
    "comment_count": 0
  }
]`

const GATE_CREATE_STDOUT = `✓ Created gate tst-77h (type: human)
  Blocks: tst-lmc (Add SSE endpoint to the server)
  Reason: Retries per-request or per-connection?

Resolve with: bd gate resolve tst-77h
`

const gateListJson = (title: string) => `[
  {
    "id": "tst-77h",
    "title": ${JSON.stringify(title)},
    "description": "Ad-hoc gate blocking tst-lmc",
    "status": "open",
    "priority": 2,
    "issue_type": "gate",
    "await_type": "human"
  }
]`

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

describe('BeadsTracker', () => {
  test('parses ready work', async () => {
    const { exec, calls } = fake((c) => (c.includes('ready') ? ok(READY_JSON) : undefined))
    const tasks = await new BeadsTracker({ cwd: '/repo', exec }).ready()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual({
      id: 'tst-lmc',
      title: 'Add SSE endpoint to the server',
      description: 'Stream events to the dashboard',
      status: 'open',
      priority: 1,
      type: 'task',
      url: null,
    })
    expect(calls[0]).toContain('--json')
  })

  test('an empty queue is an empty array, not an error', async () => {
    const { exec } = fake(() => ok('[]\n'))
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    expect(await tracker.ready()).toEqual([])
    expect(await tracker.claim()).toBeNull()
  })

  test('claim uses the atomic bd flag and reports in_progress', async () => {
    const { exec, calls } = fake((c) => (c.includes('--claim') ? ok(CLAIMED_JSON) : undefined))
    const task = await new BeadsTracker({ cwd: '/repo', exec }).claim()

    expect(task?.id).toBe('tst-lmc')
    expect(task?.status).toBe('in_progress')
    expect(calls[0]).toEqual(['bd', 'ready', '--claim', '--json'])
  })

  test('actor is threaded through for provenance', async () => {
    const { exec, calls } = fake(() => ok('[]'))
    await new BeadsTracker({ cwd: '/repo', exec, actor: 'amagi' }).ready()
    expect(calls[0]?.slice(0, 3)).toEqual(['bd', '--actor', 'amagi'])
  })

  test('a lost lease is reported rather than thrown', async () => {
    const exec: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'lease reclaimed' })
    expect(await new BeadsTracker({ cwd: '/repo', exec }).heartbeat('tst-lmc')).toBe(false)
  })

  test('a live lease heartbeats true', async () => {
    const { exec } = fake(() => ok(''))
    expect(await new BeadsTracker({ cwd: '/repo', exec }).heartbeat('tst-lmc')).toBe(true)
  })

  test('comments go over stdin so arbitrary text survives', async () => {
    let seenStdin: string | undefined
    const exec: Exec = async (_cmd, opts) => {
      seenStdin = opts?.stdin
      return ok('')
    }
    await new BeadsTracker({ cwd: '/repo', exec }).comment('tst-lmc', '--not-a-flag\n"quoted"')
    expect(seenStdin).toBe('--not-a-flag\n"quoted"')
  })

  test('gate id comes from a tagged lookup, not from parsing prose', async () => {
    const title = gateTitle('q-1')
    const { exec, calls } = fake((c) => {
      if (c.includes('create')) return ok(GATE_CREATE_STDOUT)
      if (c.includes('list')) return ok(gateListJson(title))
      return undefined
    })

    const ref = await new BeadsTracker({ cwd: '/repo', exec }).openGate('tst-lmc', {
      id: 'q-1',
      text: 'Retries per-request or per-connection?',
      options: ['per-request', 'per-connection'],
    })

    expect(ref).toEqual({ id: 'tst-77h', advisory: false })
    const create = calls.find((c) => c.includes('create'))
    expect(create).toContain(title)
    expect(create?.join(' ')).toContain('per-request | per-connection')
  })

  test('a gate that cannot be found after creation is an error, not a silent null', async () => {
    const { exec } = fake((c) => {
      if (c.includes('create')) return ok(GATE_CREATE_STDOUT)
      if (c.includes('list')) return ok('[]')
      return undefined
    })
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    expect(tracker.openGate('tst-lmc', { id: 'q-1', text: 'which?', options: [] })).rejects.toThrow(
      /q-1/,
    )
  })

  test('a closed gate reads as resolved', async () => {
    const { exec } = fake(() => ok('[{"id":"tst-77h","title":"g","status":"closed"}]'))
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    expect(await tracker.gateResolved({ id: 'tst-77h', advisory: false })).toBe(true)
  })

  test('a still-open gate keeps blocking', async () => {
    const { exec } = fake(() => ok('[{"id":"tst-77h","title":"g","status":"open"}]'))
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    expect(await tracker.gateResolved({ id: 'tst-77h', advisory: false })).toBe(false)
  })

  test('a nonzero exit surfaces stderr', async () => {
    const exec: Exec = async () => ({ exitCode: 2, stdout: '', stderr: 'no such issue' })
    expect(new BeadsTracker({ cwd: '/repo', exec }).ready()).rejects.toThrow(/no such issue/)
  })
})
