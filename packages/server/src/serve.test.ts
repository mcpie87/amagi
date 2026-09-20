import { afterEach, expect, test } from 'bun:test'
import { openDatabase, Store, type TaskRow } from '@amagi/core'
import { serve } from './serve.ts'

let server: ReturnType<typeof serve> | null = null

afterEach(async () => {
  await server?.stop(true)
  server = null
})

test('serves the API over a real socket', async () => {
  const store = new Store(openDatabase(':memory:'))
  store.append('bd-1', { type: 'task.claimed', title: 'boot the server', tracker: 'beads' })

  server = serve({ store, host: '127.0.0.1', port: 0 })
  const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks`)

  expect(res.status).toBe(200)
  expect(((await res.json()) as TaskRow[])[0]?.id).toBe('bd-1')
})

test('serves dashboard assets with SPA fallback', async () => {
  const store = new Store(openDatabase(':memory:'))
  const dir = `${import.meta.dir}/../../dashboard/dist`
  server = serve({ store, host: '127.0.0.1', port: 0, staticDir: dir })

  const index = await fetch(`http://127.0.0.1:${server.port}/`)
  expect(index.status).toBe(200)

  const deep = await fetch(`http://127.0.0.1:${server.port}/tasks/am-1`)
  expect(deep.status).toBe(200)

  const api = await fetch(`http://127.0.0.1:${server.port}/api/health`)
  expect(api.status).toBe(200)
})
