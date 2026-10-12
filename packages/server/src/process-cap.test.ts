import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGlobalConfig, setHarnessProcessCap } from '@amagi/core'
import { type AppType, createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

describe('harness process cap setting', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  let home: string
  let workspaces: TestWorkspaces
  let app: AppType
  const save = (body: unknown) =>
    app.request('/api/harness-process-cap', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'amagi-process-cap-'))
    process.env.XDG_CONFIG_HOME = home
    workspaces = testWorkspaces([])
    app = createApp({ workspaces: workspaces.workspaces })
  })

  afterEach(() => {
    setHarnessProcessCap(null)
    workspaces.cleanup()
    rmSync(home, { recursive: true, force: true })
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
  })

  test('reads the default and persists an edited cap to the global config', async () => {
    expect(await (await app.request('/api/harness-process-cap')).json()).toEqual({
      maxProcesses: 5,
    })
    const saved = await save({ maxProcesses: 3 })
    expect(saved.status).toBe(200)
    expect(loadGlobalConfig().harness.maxProcesses).toBe(3)
    for (const maxProcesses of [0, 2.5, 65, '4']) {
      expect((await save({ maxProcesses })).status).toBe(400)
    }
    expect(loadGlobalConfig().harness.maxProcesses).toBe(3)
  })
})
