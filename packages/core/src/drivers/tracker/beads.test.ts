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

const READY_WITH_DIFFICULTY_JSON = `[
  {
    "id": "tst-dif",
    "title": "Harden the merge path",
    "description": "Handle edge cases",
    "status": "open",
    "priority": 2,
    "issue_type": "feature",
    "metadata": {
      "difficulty": "high"
    }
  }
]`

const READY_WITHOUT_CREATED_AT_JSON = `[
  {
    "id": "tst-noc",
    "title": "No creation stamp",
    "description": "Tracker omitted the date",
    "status": "open",
    "priority": 3,
    "issue_type": "task"
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
        "id": "tst-epic",
        "title": "Parent epic",
        "status": "open",
        "priority": 2,
        "issue_type": "epic",
        "dependency_type": "parent-child"
      },
      {
        "id": "tst-abc",
        "title": "Blocker",
        "status": "blocked",
        "priority": 1,
        "issue_type": "task",
        "dependency_type": "blocks"
      },
      {
        "id": "tst-human",
        "title": "Human step",
        "status": "open",
        "priority": 3,
        "issue_type": "task",
        "labels": ["human"],
        "dependency_type": "blocks"
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

/** Recorded from bd 1.3.0 (`bd epic close-eligible --dry-run --json`). */
const CLOSE_ELIGIBLE_JSON = `[
  {
    "epic": {
      "id": "tst-1",
      "title": "M4: question channel",
      "description": "desc",
      "status": "open",
      "priority": 1,
      "issue_type": "epic"
    },
    "total_children": 7,
    "closed_children": 7,
    "eligible_for_close": true
  },
  {
    "epic": {
      "id": "tst-2",
      "title": "M6: review loop",
      "description": "desc",
      "status": "open",
      "priority": 2,
      "issue_type": "epic"
    },
    "total_children": 5,
    "closed_children": 0,
    "eligible_for_close": false
  }
]`

/** Recorded from bd 1.3.0 (`bd epic close-eligible --reason ... --json`). */
const EPIC_CLOSE_JSON = `{
  "closed": ["tst-1"],
  "count": 1,
  "reason": "All children completed",
  "schema_version": 1
}`

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
      createdAt: Date.parse('2026-09-20T14:02:53Z'),
    })
    expect(calls[0]).toContain('--json')
    expect(calls[0]?.[calls[0].indexOf('--sort') + 1]).toBe('oldest')
  })

  test('surfaces the difficulty level stored in metadata', async () => {
    const { exec } = fake((c) => (c.includes('ready') ? ok(READY_WITH_DIFFICULTY_JSON) : undefined))
    const tasks = await new BeadsTracker({ cwd: '/repo', exec }).ready()
    expect(tasks[0]?.difficulty).toBe('high')
  })

  test('leaves createdAt absent when bd omits the stamp', async () => {
    const { exec } = fake((c) =>
      c.includes('ready') ? ok(READY_WITHOUT_CREATED_AT_JSON) : undefined,
    )
    const tasks = await new BeadsTracker({ cwd: '/repo', exec }).ready()
    expect(tasks[0]?.createdAt).toBeUndefined()
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
    expect(calls[0]?.[calls[0].indexOf('--sort') + 1]).toBe('oldest')
  })

  test('claim falls back to a by-id claim when ready --claim skips a pre-assigned issue', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('update')
        ? ok('')
        : c.includes('show')
          ? ok(CLAIMED_JSON)
          : c.includes('--claim')
            ? ok('[]')
            : c.includes('ready')
              ? ok(READY_JSON)
              : undefined,
    )
    const task = await new BeadsTracker({ cwd: '/repo', exec }).claim()

    expect(task?.id).toBe('tst-lmc')
    expect(task?.status).toBe('in_progress')
    const update = calls.find((c) => c.includes('update'))
    expect(update?.slice(0, 4)).toEqual(['bd', 'update', 'tst-lmc', '--status'])
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

  test('openIds lists without --all, so closed issues are excluded', async () => {
    const { exec, calls } = fake((c) => (c.includes('list') ? ok(READY_JSON) : undefined))
    const ids = await new BeadsTracker({ cwd: '/repo', exec }).openIds()
    expect(ids).toEqual(['tst-lmc'])
    expect(calls[0]).not.toContain('--all')
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

  test('release is a no-op for an already-closed issue', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('show') ? ok('[{"id":"tst-lmc","title":"x","status":"closed"}]') : undefined,
    )
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.release('tst-lmc')

    expect(calls.some((c) => c.includes('unclaim'))).toBe(false)
  })

  test('release unclaims a claimed in-progress issue', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('show')
        ? ok('[{"id":"tst-lmc","title":"x","status":"in_progress","assignee":"amagi"}]')
        : undefined,
    )
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.release('tst-lmc')

    const unclaim = calls.find((c) => c.includes('unclaim'))
    expect(unclaim).toBeDefined()
  })

  // bd unclaim exits 1 on an unassigned issue, which the stall watcher turns
  // into a needs_human park for a task that needed no human at all.
  test('release reopens an in-progress issue with no assignee without unclaiming', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('show') ? ok('[{"id":"tst-lmc","title":"x","status":"in_progress"}]') : undefined,
    )
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.release('tst-lmc')

    expect(calls.some((c) => c.includes('unclaim'))).toBe(false)
    expect(calls.some((c) => c.join(' ').includes('update tst-lmc --status open'))).toBe(true)
  })

  test('release leaves an open unassigned issue alone', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('show') ? ok('[{"id":"tst-lmc","title":"x","status":"open"}]') : undefined,
    )
    const tracker = new BeadsTracker({ cwd: '/repo', exec })
    await tracker.release('tst-lmc')

    expect(calls.some((c) => c.includes('unclaim') || c.includes('update'))).toBe(false)
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
      parent: 'tst-epic',
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
    expect(call).toContain('--parent')
    expect(call).toContain('tst-epic')
  })

  test('create stamps the difficulty level as metadata', async () => {
    const { exec, calls } = fake((c) => (c.includes('create') ? ok(CREATE_JSON) : undefined))
    await new BeadsTracker({ cwd: '/repo', exec }).createTask({
      title: 'Ship the board',
      description: '',
      acceptanceCriteria: null,
      priority: null,
      labels: [],
      dependencies: [],
      parent: null,
      difficulty: 'high',
    })
    const call = calls[0]
    expect(call?.[call.indexOf('--metadata') + 1]).toBe('{"difficulty":"high"}')
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
      parent: null,
    })
    const call = calls[0]?.join(' ')
    expect(call).toContain('--title')
    expect(call).not.toContain('--description')
    expect(call).not.toContain('--acceptance')
    expect(call).not.toContain('--priority')
    expect(call).not.toContain('--labels')
    expect(call).not.toContain('--deps')
    expect(call).not.toContain('--parent')
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

  test('setMetadata sets each key on the issue', async () => {
    const { exec, calls } = fake(() => ok(''))
    await new BeadsTracker({ cwd: '/repo', exec }).setMetadata('tst-1', {
      iterations: '2',
      difficulty: 'high',
    })

    const call = calls[0]
    expect(call?.slice(0, 2)).toEqual(['bd', 'update'])
    expect(call).toContain('tst-1')
    expect(call).toContain('--set-metadata')
    expect(call).toContain('iterations=2')
    expect(call).toContain('difficulty=high')
  })

  test('children surfaces the child issues of a container', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('children') ? ok(SHOW_WITH_DEPS_JSON) : undefined,
    )
    const children = await new BeadsTracker({ cwd: '/repo', exec }).children('tst-epic')

    expect(children).toHaveLength(1)
    expect(children[0]?.id).toBe('tst-1')
    expect(calls[0]?.slice(0, 4)).toEqual(['bd', 'children', 'tst-epic', '--json'])
  })

  test('getIssue surfaces blocking dependencies with their state and labels, not the parent', async () => {
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
        labels: [],
      },
      {
        id: 'tst-human',
        title: 'Human step',
        description: '',
        status: 'open',
        priority: 3,
        type: 'task',
        url: null,
        labels: ['human'],
      },
    ])
  })

  test('dependents lists the issues this one blocks', async () => {
    const { exec, calls } = fake((c) =>
      c.includes('dep')
        ? ok(`[{"id": "tst-next", "title": "Next", "status": "open", "dependency_type": "blocks"}]`)
        : undefined,
    )
    const dependents = await new BeadsTracker({ cwd: '/repo', exec }).dependents('tst-1')

    expect(dependents.map((d) => d.id)).toEqual(['tst-next'])
    expect(calls[0]).toEqual([
      'bd',
      'dep',
      'list',
      'tst-1',
      '--direction',
      'up',
      '--type',
      'blocks',
      '--json',
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

  test('eligibleEpics previews only the eligible epics from the dry-run', async () => {
    const { exec, calls } = fake((c) => (c.includes('epic') ? ok(CLOSE_ELIGIBLE_JSON) : undefined))
    const epics = await new BeadsTracker({ cwd: '/repo', exec }).eligibleEpics()

    expect(epics).toEqual([
      {
        id: 'tst-1',
        title: 'M4: question channel',
        status: 'open',
        totalChildren: 7,
        closedChildren: 7,
      },
    ])
    expect(calls[0]?.slice(0, 4)).toEqual(['bd', 'epic', 'close-eligible', '--dry-run'])
    expect(calls[0]).toContain('--json')
  })

  test('closeEligibleEpics runs the close with the operator reason', async () => {
    const { exec, calls } = fake((c) => (c.includes('epic') ? ok(EPIC_CLOSE_JSON) : undefined))
    const result = await new BeadsTracker({ cwd: '/repo', exec }).closeEligibleEpics(
      'All children completed',
    )

    expect(result).toEqual({ closed: ['tst-1'], reason: 'All children completed' })
    const call = calls[0]
    expect(call?.slice(0, 3)).toEqual(['bd', 'epic', 'close-eligible'])
    expect(call).toContain('--reason')
    expect(call).toContain('All children completed')
    expect(call).toContain('--json')
  })
})
