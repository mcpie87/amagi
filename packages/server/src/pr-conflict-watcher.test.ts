import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, type Exec, type Harness, type PrInfo } from '@amagi/core'
import { startPrConflictWatcher } from './pr-conflict-watcher.ts'

const config = (): Config =>
  Config.parse({ repo: { baseBranch: 'main', worktreeRoot: '/wt' }, checks: { commands: [] } })

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 7,
  title: 'Do the thing',
  url: 'https://github.com/owner/repo/pull/7',
  headRefName: 'amagi/am-1-do-the-thing',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefOid: 'deadbeef',
  updatedAt: '2026-09-21T10:00:00Z',
  ...over,
})

function fakeExec(prs: () => PrInfo[]): Exec {
  return async (cmd) => {
    if (cmd.includes('gh') && cmd.includes('list')) {
      return { exitCode: 0, stdout: JSON.stringify(prs()), stderr: '' }
    }
    if (cmd.includes('rev-parse')) return { exitCode: 1, stdout: '', stderr: '' }
    if (cmd.includes('merge')) return { exitCode: 1, stdout: '', stderr: 'conflict' }
    if (cmd.includes('view')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

function fakeHarness(onStart: () => void): Harness {
  const process = {
    pid: -1,
    events: async function* () {},
    done: Promise.resolve({
      exitCode: 0,
      ok: true,
      sessionId: null,
      summary: 'done',
      usage: null,
      stderr: '',
    }),
    kill: async () => {},
    model: null,
    effort: null,
  }
  return {
    kind: 'fake',
    start: (_opts: { cwd: string; prompt: string; systemPrompt: string }) => {
      onStart()
      return process
    },
    resume: () => process,
    listModels: async () => [],
    listEfforts: async () => [],
  }
}

let cacheDir: string
const watchers: ReturnType<typeof startPrConflictWatcher>[] = []

beforeEach(() => {
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  cacheDir = mkdtempSync(join(tmpdir(), 'amagi-conflict-watch-'))
  process.env.XDG_CACHE_HOME = cacheDir
})

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop()
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  delete process.env.XDG_CACHE_HOME
  rmSync(cacheDir, { recursive: true, force: true })
})

const start = (
  exec: Exec,
  makeHarnessFn: () => Harness,
  over: Partial<Parameters<typeof startPrConflictWatcher>[0]> = {},
) => {
  const w = startPrConflictWatcher({
    repo: 'amagi',
    root: '/repo',
    repoName: 'demo',
    config: config(),
    intervalMs: 10,
    exec,
    makeHarnessFn,
    ...over,
  })
  watchers.push(w)
  return w
}

const stateFile = (): Record<string, { headOid: string }> =>
  JSON.parse(readFileSync(join(cacheDir, 'amagi', 'conflicts', 'demo.json'), 'utf8') as string)

const counter = (w: ReturnType<typeof startPrConflictWatcher>, label: string): number =>
  w.activity().counters.find((c) => c.label === label)?.value ?? 0

test('lists open PRs, resolves only conflicting ones, and records counters', async () => {
  let started = 0
  const exec = fakeExec(() => [
    pr(),
    pr({ number: 8, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
  ])
  const w = start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)

  const activity = w.activity()
  expect(activity.ok).toBe(true)
  expect(counter(w, 'scanned')).toBe(2)
  expect(counter(w, 'conflicting')).toBe(1)
  expect(counter(w, 'resolved')).toBe(1)
  expect(started).toBe(1)
  expect(stateFile()['7']).toEqual({ headOid: 'deadbeef' })
  expect(activity.runs).toBeGreaterThanOrEqual(1)
  expect(activity.successes).toBe(activity.runs)
  expect(activity.failures).toBe(0)
  expect(activity.status).toBe('active')
  expect(activity.nextRunAt).toBeGreaterThan(activity.lastRunAt)
})

test('does not re-attempt a conflicting PR until its head SHA changes', async () => {
  let started = 0
  const exec = fakeExec(() => [pr()])
  const w = start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)
  const afterFirst = started

  await Bun.sleep(60)
  expect(started).toBe(afterFirst)
  expect(counter(w, 'resolved')).toBeGreaterThanOrEqual(1)
})

test('re-attempts a conflicting PR once its head SHA changes', async () => {
  let started = 0
  let head = 'deadbeef'
  const exec = fakeExec(() => [pr({ headRefOid: head })])
  start(exec, () => fakeHarness(() => started++))

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)

  head = 'newsha'
  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(2)
  expect(stateFile()['7']).toEqual({ headOid: 'newsha' })
})

test('a failed resolution is recorded so the same head is not retried', async () => {
  let started = 0
  const fail = true
  const exec = fakeExec(() => [pr()])
  const w = start(exec, () =>
    fakeHarness(() => {
      started++
      if (fail) throw new Error('agent failed: model overloaded')
    }),
  )

  await Bun.sleep(60)
  expect(started).toBeGreaterThanOrEqual(1)
  expect(counter(w, 'resolved')).toBe(0)

  const afterFirst = started
  await Bun.sleep(60)
  expect(started).toBe(afterFirst)
  expect(stateFile()['7']).toEqual({ headOid: 'deadbeef' })
})

test('a conflicting PR that stops conflicting drops out of the state file', async () => {
  let conflicting = true
  const exec = fakeExec(() => [
    pr({
      mergeable: conflicting ? 'CONFLICTING' : 'MERGEABLE',
      mergeStateStatus: conflicting ? 'DIRTY' : 'CLEAN',
    }),
  ])
  start(exec, () => fakeHarness(() => {}))

  await Bun.sleep(60)
  expect(stateFile()['7']).toBeDefined()

  conflicting = false
  await Bun.sleep(60)
  expect(stateFile()['7']).toBeUndefined()
})

test('a tick that fails to list PRs reports the error and keeps the previous stamp', async () => {
  const failing: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'gh: not logged in' })
  const w = start(failing, () => fakeHarness(() => {}))

  await Bun.sleep(60)

  const activity = w.activity()
  expect(activity.ok).toBe(false)
  expect(activity.error).toContain('not logged in')
  expect(activity.lastRunAt).toBeGreaterThan(0)
})
