import { afterEach, expect, test } from 'bun:test'
import type { ProjectedTask } from '@amagi/core'
import { portInUse, serve } from './serve.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
let server: ReturnType<typeof serve> | null = null

afterEach(async () => {
  await server?.stop(true)
  server = null
  ws.cleanup()
})

test('serves the API over a real socket', async () => {
  ws = testWorkspaces(['repo1'])
  ws.store('repo1').append('bd-1', {
    type: 'task.claimed',
    title: 'boot the server',
    tracker: 'beads',
  })

  server = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0 })
  const res = await fetch(`http://127.0.0.1:${server.port}/api/repos/repo1/tasks`)

  expect(res.status).toBe(200)
  expect(((await res.json()) as ProjectedTask[])[0]?.id).toBe('bd-1')
})

test('serves dashboard assets with SPA fallback', async () => {
  ws = testWorkspaces(['repo1'])
  const dir = `${import.meta.dir}/../../dashboard/dist`
  server = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0, staticDir: dir })

  const index = await fetch(`http://127.0.0.1:${server.port}/`)
  expect(index.status).toBe(200)

  const deep = await fetch(`http://127.0.0.1:${server.port}/tasks/am-1`)
  expect(deep.status).toBe(200)

  const api = await fetch(`http://127.0.0.1:${server.port}/api/health`)
  expect(api.status).toBe(200)
})

test('portInUse tracks whether the port is bound', async () => {
  ws = testWorkspaces(['repo1'])
  const bound = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0 })
  const port = bound.port ?? 0
  expect(port).toBeGreaterThan(0)
  expect(portInUse('127.0.0.1', port)).toBe(true)

  await bound.stop(true)
  expect(portInUse('127.0.0.1', port)).toBe(false)
})
