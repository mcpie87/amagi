import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../../exec.ts'
import { CLAIM_LABEL, ForgejoTracker, GithubTracker } from './forge.ts'

const GH_READY = `[
  {
    "number": 3,
    "title": "Add SSE endpoint",
    "body": "Stream events to the dashboard",
    "state": "OPEN",
    "url": "https://github.com/acme/amagi/issues/3",
    "labels": []
  },
  {
    "number": 5,
    "title": "Claimed elsewhere",
    "body": "",
    "state": "OPEN",
    "url": "https://github.com/acme/amagi/issues/5",
    "labels": [{ "name": "${CLAIM_LABEL}" }]
  }
]`

const GH_VIEW = `{
  "number": 3,
  "title": "Add SSE endpoint",
  "body": "Stream events to the dashboard",
  "state": "OPEN",
  "url": "https://github.com/acme/amagi/issues/3",
  "labels": []
}`

const GH_COMMENTS = `{
  "comments": [
    { "body": "[amagi] question q-1\\n\\nRetries per-request or per-connection?" },
    { "body": "[amagi] answer q-1" }
  ]
}`

const TEA_READY = `[
  {
    "index": 7,
    "state": "open",
    "title": "Add Forgejo driver",
    "body": "Implement tea issues",
    "url": "https://gitea.local/acme/amagi/issues/7",
    "labels": []
  }
]`

const TEA_COMMENTS = `[
  { "content": "[amagi] question q-2\\n\\nWhich base?" }
]`

const TEA_COMMENTS_ANSWERED = `[
  { "content": "[amagi] question q-2\\n\\nWhich base?" },
  { "content": "[amagi] answer q-2" }
]`

type Call = readonly string[]

function fake(routes: (cmd: Call) => ExecResult | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = async (cmd, opts) => {
    calls.push(cmd)
    if (opts?.stdin !== undefined) calls.push(['<stdin>', opts.stdin])
    const hit = routes(cmd)
    if (hit) return hit
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { exec, calls }
}

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

describe('GithubTracker', () => {
  test('parses open issues and skips claimed ones', async () => {
    const { exec } = fake(() => ok(GH_READY))
    const tasks = await new GithubTracker({ cwd: '/repo', exec }).ready()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toEqual({
      id: '3',
      title: 'Add SSE endpoint',
      description: 'Stream events to the dashboard',
      status: 'open',
      priority: null,
      type: null,
      url: 'https://github.com/acme/amagi/issues/3',
    })
  })

  test('claim marks the issue with the claim label', async () => {
    const { exec, calls } = fake((c) => (c.includes('view') ? ok(GH_VIEW) : undefined))
    const task = await new GithubTracker({ cwd: '/repo', exec }).claim('3')

    expect(task?.id).toBe('3')
    const edit = calls.find((c) => c.includes('edit'))
    expect(edit).toEqual(['gh', 'issue', 'edit', '3', '--add-label', CLAIM_LABEL])
  })

  test('heartbeat is a no-op on a host without leases', async () => {
    const { exec } = fake(() => ok(''))
    expect(await new GithubTracker({ cwd: '/repo', exec }).heartbeat('3')).toBe(true)
  })

  test('a question gate is advisory and resolves via the answer comment', async () => {
    const { exec } = fake((c) => {
      if (c.includes('--json') && c.includes('comments')) return ok(GH_COMMENTS)
      return ok(GH_VIEW)
    })
    const tracker = new GithubTracker({ cwd: '/repo', exec })

    const ref = await tracker.openGate('3', {
      id: 'q-1',
      text: 'Retries per-request or per-connection?',
      options: ['per-request', 'per-connection'],
    })
    expect(ref).toEqual({ id: '3#q-1', advisory: true })
    expect(await tracker.gateResolved(ref)).toBe(true)
  })

  test('an unanswered question keeps blocking', async () => {
    const { exec } = fake(() => ok('{"comments": []}'))
    const tracker = new GithubTracker({ cwd: '/repo', exec })
    expect(await tracker.gateResolved({ id: '3#q-9', advisory: true })).toBe(false)
  })
})

describe('ForgejoTracker', () => {
  test('parses open issues from tea', async () => {
    const { exec } = fake(() => ok(TEA_READY))
    const tasks = await new ForgejoTracker({ cwd: '/repo', exec }).ready()

    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.id).toBe('7')
    expect(tasks[0]?.status).toBe('open')
  })

  test('an unanswered question keeps blocking', async () => {
    const { exec } = fake((c) => {
      if (c.includes('comments') && c.includes('list')) return ok(TEA_COMMENTS)
      return ok(TEA_READY)
    })
    const tracker = new ForgejoTracker({ cwd: '/repo', exec })
    expect(await tracker.gateResolved({ id: '7#q-2', advisory: true })).toBe(false)
  })

  test('the answer comment resolves the gate', async () => {
    const { exec } = fake((c) => {
      if (c.includes('comments') && c.includes('list')) return ok(TEA_COMMENTS_ANSWERED)
      return ok(TEA_READY)
    })
    const tracker = new ForgejoTracker({ cwd: '/repo', exec })
    expect(await tracker.gateResolved({ id: '7#q-2', advisory: true })).toBe(true)
  })
})
