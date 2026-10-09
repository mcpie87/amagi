import { afterEach, expect, test } from 'bun:test'
import { RequestTimings, type TimingSnapshot } from '@amagi/core'
import { createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
afterEach(() => ws.cleanup())

test('records API requests under their route pattern and source, not the diagnostics poll itself', async () => {
  ws = testWorkspaces(['repo1'])
  const timings = new RequestTimings()
  const app = createApp({ workspaces: ws.workspaces, timings })

  await app.request('/api/repos/repo1/questions?limit=5', {
    headers: { referer: 'http://localhost:7777/repos/repo1/inbox' },
  })
  await app.request('/api/nope', { headers: { 'user-agent': 'Bun/1.3.0' } })
  const res = await app.request('/api/diagnostics/requests')

  expect(res.status).toBe(200)
  const recent = timings.snapshot().recent
  expect(recent.map((s) => [s.route, s.path, s.source, s.status])).toEqual([
    ['(no route)', '/api/nope', 'client Bun/1.3.0', 404],
    ['/api/repos/:repo/questions', '/api/repos/repo1/questions', 'page /repos/repo1/inbox', 200],
  ])
  expect(recent.map((s) => [s.query, s.referer, s.userAgent])).toEqual([
    ['', null, 'Bun/1.3.0'],
    ['limit=5', 'http://localhost:7777/repos/repo1/inbox', null],
  ])
})

test('applies the query as a filter and rejects malformed bounds', async () => {
  ws = testWorkspaces(['repo1'])
  const timings = new RequestTimings()
  const app = createApp({ workspaces: ws.workspaces, timings })
  await app.request('/api/repos/repo1/questions', { headers: { 'user-agent': 'Bun/1.3.0' } })
  await app.request('/api/health')

  const res = await app.request('/api/diagnostics/requests?request=questions&minMs=0')
  const body = (await res.json()) as TimingSnapshot
  expect(body.recent.map((s) => s.route)).toEqual(['/api/repos/:repo/questions'])

  expect((await app.request('/api/diagnostics/requests?minMs=fast')).status).toBe(400)
})
