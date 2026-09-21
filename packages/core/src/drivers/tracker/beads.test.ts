import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../../exec.ts'
import { BeadsTracker, gateTitle, HUMAN_ONLY_LABEL } from './beads.ts'

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

const CREATE_JSON = `{
  "id": "tst-new",
  "title": "Ship the board",
  "description": "Make it writable",
  "acceptance_criteria": "It saves",
  "status": "open",
  "priority": 1,
  "issue_type": "task",
  "labels": ["ui", "board"]
}`

const SHOW_WITH_DEPS_JSON = `[
  {
    "id": "tst-1",
    "title": "Main task",
    "description": "desc",
    "status": "open",
    "priority": 2,
    "issue_type": "feature",
    "labels": ["x"],
    "notes": "root cause already found here",
    "comments": [
      { "id": "c1", "issue_id": "tst-1", "author": "someone", "text": "try the fix", "created_at": "2026-09-20T14:02:53Z" }
    ],
    "dependencies": [
      {
        "id": "tst-abc",
        "title": "Blocker",
        "status": "blocked",
        "priority": 1,
        "issue_type": "task"
      }
    ]
  }
]`

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
    expect(calls[0]?.slice(0, 4)).toEqual(['bd', 'ready', '--claim', '--json'])
  })

  test('epics, milestones and gates are never handed out as work', async () => {
    const { exec, calls } = fake(() => ok('[]'))
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.ready()
    await tracker.claim()

    for (const call of calls) {
      const excluded = call[call.indexOf('--exclude-type') + 1]
      expect(excluded).toBe('epic,milestone,gate')
    }
  })

  test('work labelled for a human is left alone', async () => {
    const { exec, calls } = fake(() => ok('[]'))
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.ready()
    await tracker.claim()

    for (const call of calls) {
      expect(call[call.indexOf('--exclude-label') + 1]).toBe(HUMAN_ONLY_LABEL)
    }
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

  test('creates an issue with the planned-work fields', async () => {
    const { exec, calls } = fake((c) => (c.includes('create') ? ok(CREATE_JSON) : undefined))
    const task = await new BeadsTracker({ cwd: '/repo', exec }).createTask({
      title: 'Ship the board',
      description: 'Make it writable',
      acceptanceCriteria: 'It saves',
      priority: 1,
      labels: ['ui', 'board'],
      dependencies: ['tst-abc'],
    })

    expect(task?.id).toBe('tst-new')
    expect(task?.title).toBe('Ship the board')
    const call = calls[0]
    expect(call?.slice(0, 2)).toEqual(['bd', 'create'])
    expect(call).toContain('--title')
    expect(call).toContain('--description')
    expect(call).toContain('--acceptance')
    expect(call).toContain('--priority')
    expect(call).toContain('P1')
    expect(call).toContain('--labels')
    expect(call).toContain('ui,board')
    expect(call).toContain('--deps')
    expect(call).toContain('tst-abc')
  })

  test('create omits unset fields instead of passing empties', async () => {
    const { exec, calls } = fake((c) => (c.includes('create') ? ok(CREATE_JSON) : undefined))
    await new BeadsTracker({ cwd: '/repo', exec }).createTask({
      title: 'Bare',
      description: '',
      acceptanceCriteria: null,
      priority: null,
      labels: [],
      dependencies: [],
    })
    const call = calls[0]?.join(' ')
    expect(call).toContain('--title')
    expect(call).not.toContain('--description')
    expect(call).not.toContain('--acceptance')
    expect(call).not.toContain('--priority')
    expect(call).not.toContain('--labels')
    expect(call).not.toContain('--deps')
  })

  test('update writes fields and adds and removes dependencies', async () => {
    const { exec, calls } = fake((c) => {
      if (c.includes('show')) return ok(SHOW_WITH_DEPS_JSON)
      return ok('')
    })
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.updateTask('tst-1', {
      title: 'Renamed',
      priority: 3,
      labels: ['y'],
      dependencies: { add: ['tst-dep'], remove: ['tst-old'] },
    })

    const update = calls.find((c) => c.includes('update'))
    expect(update).toContain('Renamed')
    expect(update).toContain('P3')
    expect(update).toContain('y')
    const add = calls.find((c) => c.includes('add'))
    expect(add?.slice(0, 4)).toEqual(['bd', 'dep', 'add', 'tst-1'])
    expect(add).toContain('tst-dep')
    const remove = calls.find((c) => c.includes('remove'))
    expect(remove?.slice(0, 4)).toEqual(['bd', 'dep', 'remove', 'tst-1'])
    expect(remove).toContain('tst-old')
    const returned = calls.filter((c) => c.includes('show'))
    expect(returned).toHaveLength(1)
  })

  test('getIssue surfaces dependency blockers with their state', async () => {
    const { exec } = fake((c) => (c.includes('show') ? ok(SHOW_WITH_DEPS_JSON) : undefined))
    const issue = await new BeadsTracker({ cwd: '/repo', exec }).getIssue('tst-1')

    expect(issue?.labels).toEqual(['x'])
    expect(issue?.dependencies).toEqual([
      {
        id: 'tst-abc',
        title: 'Blocker',
        description: '',
        status: 'blocked',
        priority: 1,
        type: 'task',
        url: null,
      },
    ])
  })

  test('get surfaces notes and comments and asks for them', async () => {
    const { exec, calls } = fake((c) => (c.includes('show') ? ok(SHOW_WITH_DEPS_JSON) : undefined))
    const task = await new BeadsTracker({ cwd: '/repo', exec }).get('tst-1')

    expect(task?.notes).toBe('root cause already found here')
    expect(task?.comments).toEqual(['try the fix'])
    const show = calls.find((c) => c.includes('show'))
    expect(show).toContain('--include-comments')
  })
})
