import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectedQuestion } from '@amagi/core'
import { sandboxArgv } from '../../core/src/drivers/harness/sandbox.ts'
import { serve } from '../../server/src/serve.ts'
import { type TestWorkspaces, testWorkspaces } from '../../server/src/test-util.ts'
import { askQuestion, taskIdFromBranch } from './ask.ts'

let ws: TestWorkspaces
let store: import('@amagi/core').Store
let server: ReturnType<typeof serve>
let baseUrl: string

const claim = (id: string) =>
  store.append(id, { type: 'task.claimed', title: `work on ${id}`, tracker: 'beads' })
const implementing = (id: string) => {
  for (const to of ['worktree_ready', 'implementing'] as const) {
    store.append(id, { type: 'task.state', from: null, to })
  }
}

const waitForQuestion = async (taskId: string): Promise<ProjectedQuestion> => {
  for (let i = 0; i < 500; i++) {
    const q = store.openQuestions(taskId)[0]
    if (q) return q
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('question never landed')
}

beforeEach(() => {
  ws = testWorkspaces(['repo1'])
  store = ws.store('repo1')
  server = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop(true)
  ws.cleanup()
})

test('taskIdFromBranch parses the worktree branch', () => {
  expect(taskIdFromBranch('amagi/am-19b.2-ask-cli-fallback')).toBe('am-19b.2')
  expect(taskIdFromBranch('main')).toBeNull()
})

test('answered in time: prints the answer', async () => {
  claim('bd-1')
  implementing('bd-1')
  const token = store.token('bd-1')

  const pending = askQuestion({
    baseUrl,
    repo: 'repo1',
    taskId: 'bd-1',
    token,
    question: 'which registry?',
    options: ['npm', 'nexus'],
    deadlineMs: 2000,
  })
  const q = await waitForQuestion('bd-1')
  const res = await fetch(`${baseUrl}/api/repos/repo1/tasks/bd-1/questions/${q.id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
    body: JSON.stringify({ answer: 'npm' }),
  })
  expect(res.status).toBe(200)

  expect(await pending).toEqual({ kind: 'answered', answer: 'npm' })
})

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'an isolated agent can ask using its registered repository key',
  async () => {
    claim('bd-1')
    implementing('bd-1')
    const dir = mkdtempSync(join(tmpdir(), 'amagi-ask-sandbox-'))
    const state = join(dir, 'state')
    const config = join(dir, 'config')
    mkdirSync(join(state, 'amagi'), { recursive: true })
    mkdirSync(join(config, 'amagi'), { recursive: true })
    writeFileSync(
      join(config, 'amagi', 'config.toml'),
      `[server]\nhost = "127.0.0.1"\nport = ${server.port}\n`,
    )
    const oldState = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = state
    try {
      const argv = sandboxArgv([
        process.execPath,
        join(import.meta.dir, 'index.ts'),
        'ask',
        'which registry?',
        '--task',
        'bd-1',
      ])
      const proc = Bun.spawn(argv, {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: config,
          AMAGI_REPO_KEY: 'repo1',
          AMAGI_TASK_TOKEN: store.token('bd-1'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const q = await waitForQuestion('bd-1')
      const res = await fetch(`${baseUrl}/api/repos/repo1/tasks/bd-1/questions/${q.id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Amagi-Token': store.token('bd-1') },
        body: JSON.stringify({ answer: 'npm' }),
      })
      expect(res.status).toBe(200)
      expect(await proc.exited).toBe(0)
      expect(await new Response(proc.stdout).text()).toContain('npm')
    } finally {
      if (oldState === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = oldState
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test('timed out: reports no answer yet and parks the task', async () => {
  claim('bd-1')
  implementing('bd-1')
  const token = store.token('bd-1')

  const outcome = await askQuestion({
    baseUrl,
    repo: 'repo1',
    taskId: 'bd-1',
    token,
    question: 'which registry?',
    options: [],
    deadlineMs: 20,
  })

  expect(outcome).toEqual({ kind: 'no_answer' })
  expect(store.task('bd-1')?.state).toBe('awaiting_answer')
  const asked = store.events({ taskId: 'bd-1' }).find((e) => e.type === 'question.asked')
  const q = asked?.type === 'question.asked' ? store.question(asked.questionId) : null
  expect(q?.answer).toBeNull()
  expect(q?.resolvedAt).not.toBeNull()
})
