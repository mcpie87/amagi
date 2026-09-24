import { afterEach, expect, test } from 'bun:test'
import type { PrDriver, ProjectedTask, RunServiceApi } from '@amagi/core'
import { writeConfig } from '@amagi/core'
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

test('registry participation flags gate auto-queue and reconcile pollers live', async () => {
  ws = testWorkspaces(['repo1'])
  const workspace = ws.workspaces.get('repo1')
  if (workspace === null) throw new Error('test workspace missing')
  workspace.config.loop.autoQueue = true
  ws.workspaces.updateParticipation('repo1', { workers: false, watchers: false })
  const autoQueueChanges: boolean[] = []
  const runner = {
    status: async () => ({
      name: 'repo1',
      available: true,
      capacity: 1,
      running: [],
      startedAt: {},
      resources: {},
      tasks: {},
      autoQueue: false,
    }),
    start: async () => ({ ok: false as const, status: 409 as const, error: 'empty' }),
    stop: async () => ({ ok: false as const, status: 404 as const, error: 'not running' }),
    setWorkerOn: () => {},
    retryNow: async () => ({ ok: false as const, status: 404 as const, error: 'not running' }),
    setAutoQueue: (enabled: boolean) => {
      if (autoQueueChanges.at(-1) !== enabled) autoQueueChanges.push(enabled)
    },
  } satisfies Partial<RunServiceApi>

  server = serve({
    workspaces: ws.workspaces,
    host: '127.0.0.1',
    port: 0,
    runner: runner as unknown as RunServiceApi,
    runnerRepo: 'repo1',
    repoPollerSupervisorIntervalMs: 10,
  })
  expect(autoQueueChanges).toEqual([false])
  const endpoint = `http://127.0.0.1:${server.port}/api/runner`
  expect(((await (await fetch(endpoint)).json()) as { workers: unknown[] }).workers).toEqual([])

  ws.workspaces.updateParticipation('repo1', { workers: true, watchers: true })
  await Bun.sleep(50)
  expect(autoQueueChanges).toEqual([false, true])
  expect(
    ((await (await fetch(endpoint)).json()) as { workers: { name: string }[] }).workers,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'stall-watcher' })]))
})

test('watcher enable switches reconcile from config on the next supervisor scan', async () => {
  ws = testWorkspaces(['repo1'], { forgeFor: () => ({}) as PrDriver })
  const workspace = ws.workspaces.get('repo1')
  if (workspace === null) throw new Error('test workspace missing')
  const runner = {
    status: async () => ({
      name: 'repo1',
      available: true,
      capacity: 1,
      running: [],
      startedAt: {},
      resources: {},
      tasks: {},
      autoQueue: false,
    }),
    start: async () => ({ ok: false as const, status: 409 as const, error: 'empty' }),
    stop: async () => ({ ok: false as const, status: 404 as const, error: 'not running' }),
    setWorkerOn: () => {},
    retryNow: async () => ({ ok: false as const, status: 404 as const, error: 'not running' }),
    setAutoQueue: () => {},
  } satisfies Partial<RunServiceApi>
  server = serve({
    workspaces: ws.workspaces,
    host: '127.0.0.1',
    port: 0,
    runner: runner as unknown as RunServiceApi,
    repoPollerSupervisorIntervalMs: 10,
    mentionWatchIntervalMs: 60_000,
    prConflictWatchIntervalMs: 60_000,
    stallWatchIntervalMs: 60_000,
  })
  const endpoint = `http://127.0.0.1:${server.port}/api/runner`
  const names = async () =>
    ((await (await fetch(endpoint)).json()) as { workers: { name: string }[] }).workers.map(
      (w) => w.name,
    )
  expect(await names()).toEqual(
    expect.arrayContaining(['mention-watcher', 'pr-conflict-watcher', 'stall-watcher']),
  )

  writeConfig(workspace.root, {
    watchers: { prConflict: { enabled: false }, stall: { enabled: false } },
  })
  await Bun.sleep(40)
  expect(await names()).not.toContain('pr-conflict-watcher')
  expect(await names()).not.toContain('stall-watcher')

  writeConfig(workspace.root, { watchers: { prConflict: { enabled: true } } })
  await Bun.sleep(40)
  expect(await names()).toContain('pr-conflict-watcher')
})
