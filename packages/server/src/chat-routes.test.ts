import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheHome, HARDCODED_MODELS, type Harness } from '@amagi/core'
import type { Hono } from 'hono'
import { createChatRoutes } from './chat-routes.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

describe('chat model discovery', () => {
  const savedDevHome = process.env.AMAGI_DEV_HOME
  const savedConfigHome = process.env.XDG_CONFIG_HOME
  let home: string
  let ws: TestWorkspaces
  let app: Hono
  let list: (kind: string) => Promise<string[]>
  let discovered: string[]

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'amagi-chat-models-'))
    process.env.AMAGI_DEV_HOME = home
    process.env.XDG_CONFIG_HOME = home
    ws = testWorkspaces(['repo1'])
    discovered = []
    list = () => Promise.reject(new Error('offline'))
    app = createChatRoutes({
      workspaces: ws.workspaces,
      liveTaskChats: new Map(),
      harnessFor: (_workspace, config): Harness => ({
        kind: config.kind,
        start: () => {
          throw new Error('not a chat turn')
        },
        resume: () => {
          throw new Error('not a chat turn')
        },
        listModels: () => {
          discovered.push(config.kind)
          return list(config.kind)
        },
        listEfforts: async () => [],
      }),
    })
  })

  afterEach(() => {
    ws.cleanup()
    rmSync(home, { recursive: true, force: true })
    if (savedDevHome === undefined) delete process.env.AMAGI_DEV_HOME
    else process.env.AMAGI_DEV_HOME = savedDevHome
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedConfigHome
  })

  const cache = (kind: string, models: string[]) => {
    const dir = join(cacheHome(), 'amagi', 'models')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${kind}.json`),
      JSON.stringify({ cachedAt: Date.now() - 48 * 60 * 60 * 1000, models }),
    )
  }

  test('options expose curated, stale and configured models without launching any harness', async () => {
    const workspace = ws.workspaces.get('repo1')
    if (workspace === null) throw new Error('missing workspace')
    workspace.config.harness.implement = {
      ...workspace.config.harness.implement,
      kind: 'omp',
      model: 'provider/custom',
      effort: 'high',
    }
    cache('omp', ['provider/cached'])
    list = () => new Promise(() => {})

    const response = await app.request('/api/repos/repo1/chat/options')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      harnesses: [
        { kind: 'claude' },
        { kind: 'codex' },
        { kind: 'opencode' },
        { kind: 'omp', model: 'provider/custom', effort: 'high' },
      ],
      models: {
        claude: HARDCODED_MODELS.claude,
        codex: HARDCODED_MODELS.codex,
        opencode: [],
        omp: ['provider/cached', 'provider/custom'],
      },
      defaultHarness: { kind: 'omp', model: 'provider/custom', effort: 'high' },
    })
    expect(discovered).toEqual([])
  })

  test('a pending catalog does not block options or another harness and is cached when ready', async () => {
    const started = Promise.withResolvers<void>()
    const catalog = Promise.withResolvers<string[]>()
    list = () => {
      started.resolve()
      return catalog.promise
    }
    const pending = app.request('/api/repos/repo1/chat/models/omp')
    await started.promise

    const options = await app.request('/api/repos/repo1/chat/options')
    expect(options.status).toBe(200)
    const codex = await app.request('/api/repos/repo1/chat/models/codex')
    expect(await codex.json()).toEqual({ models: HARDCODED_MODELS.codex })
    expect(discovered).toEqual(['omp'])

    catalog.resolve(['provider/new'])
    expect(await (await pending).json()).toEqual({ models: ['provider/new'] })
    expect(await (await app.request('/api/repos/repo1/chat/options')).json()).toMatchObject({
      models: { omp: ['provider/new'] },
    })
  })

  test('an offline catalog preserves stale choices and rejects unsupported harnesses', async () => {
    cache('opencode', ['provider/offline'])
    const response = await app.request('/api/repos/repo1/chat/models/opencode')
    expect(await response.json()).toEqual({ models: ['provider/offline'] })
    expect(discovered).toEqual(['opencode'])
    expect((await app.request('/api/repos/repo1/chat/models/unknown')).status).toBe(400)
    expect(discovered).toEqual(['opencode'])
  })
})
