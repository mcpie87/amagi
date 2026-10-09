import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  loadGlobalConfig,
  type ProfileConfig,
  writeGlobalConfig,
} from '@amagi/core'
import { type AppType, createApp } from './app.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

describe('profile settings', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME
  let home: string
  let workspaces: TestWorkspaces
  let app: AppType
  const profile: ProfileConfig = {
    profile_name: 'Careful',
    harness: 'codex',
    model: 'custom-model',
    effort: 'high',
  }
  const save = (body: unknown) =>
    app.request('/api/profiles', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'amagi-profiles-'))
    process.env.XDG_CONFIG_HOME = home
    workspaces = testWorkspaces([])
    app = createApp({ workspaces: workspaces.workspaces })
  })

  afterEach(() => {
    workspaces.cleanup()
    rmSync(home, { recursive: true, force: true })
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
  })

  test('lists, creates, edits and removes global profiles without a repository', async () => {
    expect(await (await app.request('/api/profiles')).json()).toEqual({
      profiles: [],
      models: HARDCODED_MODELS,
      efforts: HARDCODED_EFFORTS,
    })
    writeGlobalConfig({ server: { port: 9876 }, seats: ['shared'] })
    const created = await save({ profiles: [profile] })
    expect(created.status).toBe(200)
    expect(await created.json()).toEqual({ profiles: [profile] })
    expect(loadGlobalConfig()).toMatchObject({
      profiles: [profile],
      server: { port: 9876 },
      seats: [{ name: 'shared', count: 1 }],
    })

    const restarted = createApp({ workspaces: workspaces.workspaces })
    expect(await (await restarted.request('/api/profiles')).json()).toMatchObject({
      profiles: [profile],
    })
    const renamed = { ...profile, profile_name: 'Quick', model: 'another-model', effort: 'low' }
    expect((await save({ profiles: [renamed] })).status).toBe(200)
    expect(loadGlobalConfig().profiles).toEqual([renamed])
    expect((await save({ profiles: [] })).status).toBe(200)
    expect(loadGlobalConfig().profiles).toEqual([])
  })

  test('trims fields and rejects invalid replacements without losing saved profiles', async () => {
    expect(
      (
        await save({
          profiles: [
            { ...profile, profile_name: ' Careful ', model: ' custom-model ', effort: ' high ' },
          ],
        })
      ).status,
    ).toBe(200)
    expect(loadGlobalConfig().profiles).toEqual([profile])
    for (const body of [
      {},
      { profiles: null },
      { profiles: [profile, { ...profile, profile_name: ' Careful ' }] },
      ...['profile_name', 'model', 'effort'].flatMap((field) => [
        { profiles: [{ ...profile, [field]: ' ' }] },
        {
          profiles: [Object.fromEntries(Object.entries(profile).filter(([key]) => key !== field))],
        },
      ]),
      { profiles: [{ ...profile, harness: 'unknown' }] },
    ]) {
      const response = await save(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toHaveProperty('error')
      expect(loadGlobalConfig().profiles).toEqual([profile])
    }
  })
})
