import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGlobalConfig, type RunServiceApi, type Workspace } from '@amagi/core'
import { createConfigRoutes } from './config-routes.ts'
import { type TestWorkspaces, testWorkspaces } from './test-util.ts'

let ws: TestWorkspaces
let home: string
const savedXdg = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amagi-config-routes-'))
  process.env.XDG_CONFIG_HOME = home
  ws = testWorkspaces(['repo1'])
})

afterEach(() => {
  ws.cleanup()
  rmSync(home, { recursive: true, force: true })
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
})

const runner = (running: string[]): RunServiceApi => ({
  status: async () => ({
    name: 'repo1',
    available: true,
    capacity: 1,
    busySeats: running.length,
    totalSeats: 1,
    running,
    startedAt: {},
    resources: {},
    tasks: {},
    autoQueue: false,
  }),
  start: async () => ({ ok: true, taskId: 'bd-1' }),
  stop: async () => ({ ok: true, taskId: 'bd-1' }),
  fleetChanged: () => {},
  retryNow: async () => ({ ok: true, taskId: 'bd-1' }),
  setAutoQueue: () => {},
})

const app = (running: string[] = []) =>
  createConfigRoutes({ workspaces: ws.workspaces, runnerFor: () => runner(running) })

const patch = (values: Record<string, unknown>, running: string[] = []) =>
  app(running).request('/api/repos/repo1/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values }),
  })

const workspace = (): Workspace => {
  const w = ws.workspaces.get('repo1')
  if (w === null) throw new Error('no workspace')
  return w
}

test('reads every editable setting, the server bind and the persona names', async () => {
  mkdirSync(join(home, 'git', 'personas'), { recursive: true })
  writeFileSync(join(home, 'git', 'personas', 'bot.gitconfig'), '[user]\n')
  const res = await app().request('/api/repos/repo1/config')
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    values: Record<string, unknown>
    server: { host: string; port: number }
    personas: string[]
  }
  expect(body.values['loop.maxCheckRounds']).toBe(2)
  expect(body.values['review.harness']).toBeNull()
  expect(body.server).toEqual({ host: '127.0.0.1', port: 7777 })
  expect(body.personas).toEqual(['bot'])
})

test('writes repo keys to the repo config, global keys to the user config, and applies them live', async () => {
  const res = await patch({
    'loop.maxCheckRounds': 5,
    'checks.commands': ['bun run e2e'],
    'difficulty.levels': ['easy', 'hard'],
  })
  expect(res.status).toBe(200)
  const repoToml = readFileSync(join(workspace().root, '.amagi', 'config.toml'), 'utf8')
  expect(repoToml).toContain('maxCheckRounds = 5')
  expect(repoToml).toContain('bun run e2e')
  expect(repoToml).not.toContain('easy')
  expect(loadGlobalConfig().difficulty.levels).toEqual(['easy', 'hard'])
  expect(workspace().config.loop.maxCheckRounds).toBe(5)
  expect(workspace().config.checks.format).toBe('true')

  expect((await patch({ 'loop.maxCheckRounds': null })).status).toBe(200)
  expect(workspace().config.loop.maxCheckRounds).toBe(2)
})

test('rejects unlisted keys and invalid values without writing anything', async () => {
  expect((await patch({ 'server.port': 1 })).status).toBe(400)
  expect((await patch({ 'loop.maxCheckRounds': -1, 'loop.maxRetries': 9 })).status).toBe(400)
  expect(workspace().config.loop.maxRetries).toBe(3)
  expect(readFileSync(join(workspace().root, '.amagi', 'config.toml'), 'utf8')).not.toContain(
    'maxRetries',
  )
})

test('refuses worktree-bound keys while a task runs, but not the rest', async () => {
  const blocked = await patch({ 'repo.baseBranch': 'develop' }, ['bd-1'])
  expect(blocked.status).toBe(409)
  expect(workspace().config.repo.baseBranch).toBe('main')
  expect((await patch({ 'forge.agentHandle': 'helper' }, ['bd-1'])).status).toBe(200)
  expect((await patch({ 'repo.baseBranch': 'develop' })).status).toBe(200)
  expect(workspace().config.repo.baseBranch).toBe('develop')
})

test('keeps the old root available while a reservation is unresolved', async () => {
  const ws = workspace()
  ws.config.repo.worktreeRoot = join(ws.root, 'trees')
  const repoKey = createHash('sha256').update(ws.root).digest('hex').slice(0, 16)
  const poolRoot = join(ws.config.repo.worktreeRoot, '.amagi-pool', repoKey)
  mkdirSync(poolRoot, { recursive: true })
  writeFileSync(join(poolRoot, 'reservation.json'), '{}')
  expect((await patch({ 'repo.worktreeRoot': join(ws.root, 'new-trees') })).status).toBe(409)
  rmSync(join(poolRoot, 'reservation.json'))
  expect((await patch({ 'repo.worktreeRoot': join(ws.root, 'new-trees') })).status).toBe(200)
})

test('a persona must name an existing persona file', async () => {
  expect((await patch({ 'repo.persona': 'nobody' })).status).toBe(400)
  mkdirSync(join(home, 'git', 'personas'), { recursive: true })
  writeFileSync(join(home, 'git', 'personas', 'bot.gitconfig'), '[user]\n')
  expect((await patch({ 'repo.persona': 'bot' })).status).toBe(200)
  expect(workspace().config.repo.persona).toBe('bot')
})

test('setup remains editable before project checks exist, without opening a workspace', async () => {
  const entry = ws.workspaces.list()[0]
  if (entry === undefined) throw new Error('repo missing')
  ws.workspaces.close()
  writeFileSync(join(entry.path, '.amagi', 'config.toml'), '[repo]\nbaseBranch = "main"\n')
  expect((await app().request('/api/repos/repo1/config')).status).toBe(200)
  expect((await patch({ 'tracker.kind': 'github', 'repo.baseBranch': 'develop' })).status).toBe(200)
  expect(readFileSync(join(entry.path, '.amagi', 'config.toml'), 'utf8')).toContain(
    'kind = "github"',
  )
  expect(() => ws.workspaces.get('repo1')).toThrow('must declare commands')
})

test('origins distinguish defaults, global values and repository overrides, and reset inherits', async () => {
  mkdirSync(join(home, 'amagi'), { recursive: true })
  writeFileSync(join(home, 'amagi', 'config.toml'), '[repo]\nbaseBranch = "develop"\n')
  await patch({ 'repo.baseBranch': 'topic' })
  const before = await (await app().request('/api/repos/repo1/config')).json()
  expect(before.origins['repo.baseBranch']).toBe('repo')
  const res = await patch({ 'repo.baseBranch': null })
  const after = await res.json()
  expect(after.values['repo.baseBranch']).toBe('develop')
  expect(after.origins['repo.baseBranch']).toBe('global')
  expect(after.origins['loop.maxRetries']).toBe('default')
})

test('global configuration can be edited with no repository, without borrowing repository overrides', async () => {
  const get = await app().request('/api/config')
  expect(get.status).toBe(200)
  expect((await get.json()).values['difficulty.enabled']).toBe(false)
  const res = await app().request('/api/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ values: { 'difficulty.enabled': true } }),
  })
  expect(res.status).toBe(200)
  expect(loadGlobalConfig().difficulty.enabled).toBe(true)
  expect(workspace().config.difficulty.enabled).toBe(true)
  expect(
    (
      await app().request('/api/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { 'repo.baseBranch': 'bad' } }),
      })
    ).status,
  ).toBe(400)
})
