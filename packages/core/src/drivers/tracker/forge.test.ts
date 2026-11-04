import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../../exec.ts'
import { CLAIM_LABEL, ForgejoTracker, GithubTracker } from './forge.ts'

type Req = { method: string; path: string; query: URLSearchParams; body: unknown }

const GH_REMOTE = 'git@github.com:acme/amagi.git'
const FJ_REMOTE = 'https://gitea.local/acme/amagi.git'
const REPO = 'repos/acme/amagi'

const GH_ISSUE = {
  number: 3,
  title: 'Add SSE endpoint',
  body: 'Stream events to the dashboard',
  state: 'open',
  html_url: 'https://github.com/acme/amagi/issues/3',
  labels: [],
  created_at: '2026-09-20T14:02:53Z',
}

const GH_CLAIMED = {
  ...GH_ISSUE,
  number: 5,
  title: 'Claimed elsewhere',
  body: null,
  html_url: 'https://github.com/acme/amagi/issues/5',
  labels: [{ name: CLAIM_LABEL }],
}

const GH_PR = { ...GH_ISSUE, number: 9, title: 'A pull request', pull_request: { url: 'x' } }

const GH_PROPOSED = { ...GH_ISSUE, labels: [{ name: 'proposed' }] }

const FJ_ISSUE = {
  number: 7,
  title: 'Add Forgejo driver',
  body: 'Implement the REST tracker',
  state: 'open',
  html_url: 'https://gitea.local/acme/amagi/issues/7',
  labels: [],
  created_at: '2026-09-20T14:02:53Z',
}

const json = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), init)

/** A list answer paged as the host does it: a Link header on GitHub, x-total-count on Forgejo. */
function collection(req: Req, items: unknown[]): Response {
  const github = req.query.has('per_page')
  const size = Number(req.query.get(github ? 'per_page' : 'limit'))
  const page = Number(req.query.get('page'))
  const headers = github
    ? { link: page * size < items.length ? '<next>; rel="next"' : '' }
    : { 'x-total-count': String(items.length) }
  return json(items.slice((page - 1) * size, page * size), { headers })
}

/** Answers the `git remote get-url` that resolves the forge endpoint. */
const remoteExec =
  (url: string): Exec =>
  async () => ({ exitCode: 0, stdout: `${url}\n`, stderr: '' })

const github = (): GithubTracker =>
  new GithubTracker({ cwd: '/repo', remote: 'origin', exec: remoteExec(GH_REMOTE) })
const forgejo = (): ForgejoTracker =>
  new ForgejoTracker({ cwd: '/repo', remote: 'origin', exec: remoteExec(FJ_REMOTE) })

/**
 * Stubs fetch while `fn` runs. `route` answers each request (path relative to
 * the API root, query split out); an unanswered request fails the test.
 */
async function withFetch<T>(
  route: (req: Req) => Response | undefined,
  fn: () => Promise<T>,
): Promise<{ value: T; requests: Req[] }> {
  const original = globalThis.fetch
  const requests: Req[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const req: Req = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/(api\/v\d\/)?/, ''),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    requests.push(req)
    const res = route(req)
    if (res === undefined) throw new Error(`unfaked ${req.method} ${req.path}`)
    return res
  }) as typeof fetch
  try {
    return { value: await fn(), requests }
  } finally {
    globalThis.fetch = original
  }
}

const savedState = process.env.XDG_STATE_HOME
let stateHome: string

beforeEach(() => {
  // Stored forge credentials would otherwise leak in from the operator's state dir.
  stateHome = mkdtempSync(join(tmpdir(), 'amagi-forge-tracker-'))
  process.env.XDG_STATE_HOME = stateHome
  delete process.env.GITHUB_TOKEN
  delete process.env.GITLAB_TOKEN
  process.env.GH_TOKEN = 'ghp_test'
  process.env.FORGEJO_TOKEN = 'fj_test'
})

afterEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.FORGEJO_TOKEN
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(stateHome, { recursive: true, force: true })
})

describe('GithubTracker', () => {
  test('parses open issues, skipping claimed ones and pull requests', async () => {
    const { value: tasks, requests } = await withFetch(
      (req) =>
        req.path === `${REPO}/issues` ? collection(req, [GH_ISSUE, GH_CLAIMED, GH_PR]) : undefined,
      () => github().ready(),
    )

    expect(requests[0]?.query.get('state')).toBe('open')
    expect(tasks).toEqual([
      {
        id: '3',
        title: 'Add SSE endpoint',
        description: 'Stream events to the dashboard',
        status: 'open',
        priority: null,
        type: null,
        url: 'https://github.com/acme/amagi/issues/3',
        createdAt: Date.parse('2026-09-20T14:02:53Z'),
      },
    ])
  })

  test('openIds includes claimed issues too, unlike ready', async () => {
    const { value: ids } = await withFetch(
      (req) =>
        req.path === `${REPO}/issues` ? collection(req, [GH_ISSUE, GH_CLAIMED]) : undefined,
      () => github().openIds(),
    )
    expect(ids).toEqual(['3', '5'])
  })

  test('proposed issues are hidden from ready and rejected by explicit claim', async () => {
    const route = (req: Req): Response | undefined => {
      if (req.path === `${REPO}/issues`) return collection(req, [GH_PROPOSED])
      if (req.path === `${REPO}/issues/3`) return json(GH_PROPOSED)
      return undefined
    }
    const ready = await withFetch(route, () => github().ready())
    expect(ready.value).toEqual([])
    const claim = await withFetch(route, () => github().claim('3'))
    expect(claim.value).toBeNull()
    expect(claim.requests.map((r) => r.method)).toEqual(['GET'])
  })

  test('a missing issue reads as null', async () => {
    const { value } = await withFetch(
      () => new Response('{"message":"Not Found"}', { status: 404 }),
      () => github().get('99'),
    )
    expect(value).toBeNull()
  })

  test('claim adds the claim label, creating it first', async () => {
    const { value: task, requests } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/3`) return json(GH_ISSUE)
        if (req.path === `${REPO}/labels`) return json({}, { status: 201 })
        if (req.path === `${REPO}/issues/3/labels`) return json([])
        return undefined
      },
      () => github().claim('3'),
    )

    expect(task?.id).toBe('3')
    expect(requests.find((r) => r.path === `${REPO}/labels`)?.body).toEqual({
      name: CLAIM_LABEL,
      color: 'A0A0A0',
    })
    expect(requests.find((r) => r.path === `${REPO}/issues/3/labels`)?.body).toEqual({
      labels: [CLAIM_LABEL],
    })
  })

  test('a label that cannot be created does not stop the claim', async () => {
    const { value: task } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/3`) return json(GH_ISSUE)
        if (req.path === `${REPO}/labels`) return json({ message: 'exists' }, { status: 422 })
        if (req.path === `${REPO}/issues/3/labels`) return json([])
        return undefined
      },
      () => github().claim('3'),
    )
    expect(task?.id).toBe('3')
  })

  test('heartbeat is a no-op on a host without leases', async () => {
    expect(await github().heartbeat('3')).toBe(true)
  })

  test('a question gate is advisory and resolves via the answer comment', async () => {
    const comments = [
      { body: '[amagi] question q-1\n\nRetries per-request or per-connection?' },
      { body: '[amagi] answer q-1' },
    ]
    await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/3`) return json(GH_ISSUE)
        if (req.path === `${REPO}/issues/3/comments`) {
          return req.method === 'POST' ? json({}, { status: 201 }) : collection(req, comments)
        }
        return undefined
      },
      async () => {
        const tracker = github()
        const ref = await tracker.openGate('3', {
          id: 'q-1',
          text: 'Retries per-request or per-connection?',
          options: ['per-request', 'per-connection'],
        })
        expect(ref).toEqual({ id: '3#q-1', advisory: true })
        expect(await tracker.gateResolved(ref)).toBe(true)
      },
    )
  })

  test('an unanswered question keeps blocking', async () => {
    const { value } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/3`) return json(GH_ISSUE)
        if (req.path === `${REPO}/issues/3/comments`) return collection(req, [])
        return undefined
      },
      () => github().gateResolved({ id: '3#q-9', advisory: true }),
    )
    expect(value).toBe(false)
  })

  test('an answer on a later comment page resolves the gate', async () => {
    const comments = [
      ...Array.from({ length: 100 }, (_, i) => ({ body: `note ${i}` })),
      { body: '[amagi] answer q-1' },
    ]
    const { value } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/3`) return json(GH_ISSUE)
        if (req.path === `${REPO}/issues/3/comments`) return collection(req, comments)
        return undefined
      },
      () => github().gateResolved({ id: '3#q-1', advisory: true }),
    )
    expect(value).toBe(true)
  })

  test('creates an issue, with its description sections in the body', async () => {
    const input = {
      title: 'x',
      description: 'Why',
      acceptanceCriteria: 'Done',
      priority: null,
      labels: ['task'],
      dependencies: [],
      parent: null,
    }
    const route = (req: Req): Response | undefined => {
      if (req.path === `${REPO}/labels`) return json({}, { status: 201 })
      if (req.path === `${REPO}/issues`) return json(GH_ISSUE, { status: 201 })
      return undefined
    }
    const tracker = github()
    expect(tracker.capabilities).toEqual({ create: true, edit: false, dependencies: false })

    const first = await withFetch(route, () => tracker.createTask(input))
    expect(first.value.id).toBe('3')
    expect(first.requests.find((r) => r.path === `${REPO}/issues`)?.body).toEqual({
      title: 'x',
      body: 'Why\n\n## Acceptance\nDone',
      labels: ['task'],
    })

    const second = await withFetch(route, () =>
      tracker.createTask({ ...input, acceptanceCriteria: null, priority: 1, parent: '2' }),
    )
    expect(second.requests.find((r) => r.path === `${REPO}/issues`)?.body).toMatchObject({
      body: 'Why\n\nParent: #2\n\nPriority: P1',
    })

    await expect(tracker.createTask({ ...input, dependencies: ['2'] })).rejects.toThrow(
      /cannot create issues/,
    )
    await expect(tracker.updateTask('3', { title: 'x' })).rejects.toThrow(
      /does not support editing issues/,
    )
  })

  test('close and reopen patch the issue state', async () => {
    const route = (req: Req): Response | undefined =>
      req.path === `${REPO}/issues/3` && req.method === 'PATCH' ? json(GH_ISSUE) : undefined
    const { requests } = await withFetch(route, async () => {
      await github().close('3')
      await github().setStatus('3', 'open')
    })
    expect(requests.map((r) => r.body)).toEqual([{ state: 'closed' }, { state: 'open' }])
  })

  test('release removes the claim label, tolerating an issue that lacks it', async () => {
    const { requests } = await withFetch(
      () => new Response('{"message":"Label does not exist"}', { status: 404 }),
      () => github().release('3'),
    )
    expect(requests[0]?.method).toBe('DELETE')
    expect(requests[0]?.path).toBe(`${REPO}/issues/3/labels/${CLAIM_LABEL}`)
  })
})

describe('ForgejoTracker', () => {
  test('parses open issues, asking the API for issues only', async () => {
    const { value: tasks, requests } = await withFetch(
      (req) => (req.path === `${REPO}/issues` ? collection(req, [FJ_ISSUE]) : undefined),
      () => forgejo().ready(),
    )

    expect(requests[0]?.query.get('type')).toBe('issues')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: '7',
      status: 'open',
      url: 'https://gitea.local/acme/amagi/issues/7',
      createdAt: Date.parse('2026-09-20T14:02:53Z'),
    })
  })

  test('creates an issue, mapping label names to ids', async () => {
    const { value: task, requests } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/labels`) {
          return req.method === 'GET'
            ? collection(req, [{ id: 4, name: 'task' }])
            : json({ message: 'exists' }, { status: 409 })
        }
        if (req.path === `${REPO}/issues`) return json(FJ_ISSUE, { status: 201 })
        return undefined
      },
      () =>
        forgejo().createTask({
          title: 'Follow up',
          description: 'From the PR',
          acceptanceCriteria: null,
          priority: null,
          labels: ['task'],
          dependencies: [],
          parent: null,
        }),
    )

    expect(task.id).toBe('7')
    expect(requests.find((r) => r.path === `${REPO}/issues`)?.body).toEqual({
      title: 'Follow up',
      body: 'From the PR',
      labels: [4],
    })
  })

  test('a label missing from the repository and not creatable fails the create', async () => {
    await expect(
      withFetch(
        (req) => {
          if (req.path === `${REPO}/labels`) {
            return req.method === 'GET'
              ? collection(req, [])
              : json({ message: 'forbidden' }, { status: 403 })
          }
          return undefined
        },
        () =>
          forgejo().createTask({
            title: 'Proposal',
            description: '',
            acceptanceCriteria: null,
            priority: null,
            labels: ['proposed'],
            dependencies: [],
            parent: null,
          }),
      ),
    ).rejects.toThrow(/has no label proposed/)
  })

  test('claim adds the claim label by id and release removes it by id', async () => {
    const labels = [{ id: 9, name: CLAIM_LABEL }]
    const route = (req: Req): Response | undefined => {
      if (req.path === `${REPO}/issues/7`) return json(FJ_ISSUE)
      if (req.path === `${REPO}/labels`) {
        return req.method === 'GET' ? collection(req, labels) : json({}, { status: 409 })
      }
      if (req.path === `${REPO}/issues/7/labels`) return json([])
      if (req.path === `${REPO}/issues/7/labels/9`) return new Response(null, { status: 204 })
      return undefined
    }

    const claim = await withFetch(route, () => forgejo().claim('7'))
    expect(claim.value?.id).toBe('7')
    expect(claim.requests.find((r) => r.path === `${REPO}/issues/7/labels`)?.body).toEqual({
      labels: [9],
    })

    const release = await withFetch(route, () => forgejo().release('7'))
    expect(release.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      `DELETE ${REPO}/issues/7/labels/9`,
    )
  })

  test('an unanswered question keeps blocking', async () => {
    const { value } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/7`) return json(FJ_ISSUE)
        if (req.path === `${REPO}/issues/7/comments`) {
          return collection(req, [{ body: '[amagi] question q-2\n\nWhich base?' }])
        }
        return undefined
      },
      () => forgejo().gateResolved({ id: '7#q-2', advisory: true }),
    )
    expect(value).toBe(false)
  })

  test('the answer comment resolves the gate', async () => {
    const { value } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues/7`) return json(FJ_ISSUE)
        if (req.path === `${REPO}/issues/7/comments`) {
          return collection(req, [
            { body: '[amagi] question q-2\n\nWhich base?' },
            { body: '[amagi] answer q-2' },
          ])
        }
        return undefined
      },
      () => forgejo().gateResolved({ id: '7#q-2', advisory: true }),
    )
    expect(value).toBe(true)
  })
})

for (const { name, Driver, remote } of [
  { name: 'GithubTracker', Driver: GithubTracker, remote: GH_REMOTE },
  { name: 'ForgejoTracker', Driver: ForgejoTracker, remote: FJ_REMOTE },
]) {
  test(`${name} claims the next eligible issue past newer claimed ones`, async () => {
    const issues = Array.from({ length: 121 }, (_, i) => ({
      number: 121 - i,
      title: 'task',
      body: '',
      state: 'open',
      html_url: null,
      labels: i < 120 ? [{ name: CLAIM_LABEL }] : [],
    }))
    const { value: task, requests } = await withFetch(
      (req) => {
        if (req.path === `${REPO}/issues`) return collection(req, issues)
        if (req.path === `${REPO}/issues/1`) return json(issues[120])
        if (req.path === `${REPO}/labels`) {
          return req.method === 'GET'
            ? collection(req, [{ id: 9, name: CLAIM_LABEL }])
            : json({}, { status: 409 })
        }
        if (req.path === `${REPO}/issues/1/labels`) return json([])
        return undefined
      },
      () => new Driver({ cwd: '/repo', remote: 'origin', exec: remoteExec(remote) }).claim(),
    )

    expect(task?.id).toBe('1')
    expect(requests.some((r) => r.method === 'POST' && r.path === `${REPO}/issues/1/labels`)).toBe(
      true,
    )
  })
}
