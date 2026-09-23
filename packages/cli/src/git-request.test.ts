import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../../server/src/serve.ts'
import { type TestWorkspaces, testWorkspaces } from '../../server/src/test-util.ts'
import { requestGitWrite, taskIdFromBranch } from './git-request.ts'

let ws: TestWorkspaces
let store: import('@amagi/core').Store
let server: ReturnType<typeof serve>
let baseUrl: string
let repo: string
let wt: string

const branch = 'amagi/am-bd1-do-something'

const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'amagi-git-request-repo-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'init'])
  wt = mkdtempSync(join(tmpdir(), 'amagi-git-request-wt-'))
  git(repo, ['worktree', 'add', '-b', branch, wt, 'main'])

  ws = testWorkspaces(['repo1'])
  store = ws.store('repo1')
  store.append('am-bd1', { type: 'task.claimed', title: 'do something', tracker: 'beads' })
  store.append('am-bd1', { type: 'worktree.created', path: wt, branch })
  store.append('am-bd1', { type: 'task.state', from: 'claimed', to: 'worktree_ready' })
  store.append('am-bd1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  server = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop(true)
  ws.cleanup()
  rmSync(repo, { recursive: true, force: true })
  rmSync(wt, { recursive: true, force: true })
})

test('taskIdFromBranch parses the worktree branch', () => {
  expect(taskIdFromBranch(branch)).toBe('am-bd1')
  expect(taskIdFromBranch('main')).toBeNull()
})

test('requesting a commit returns the sha and records commit.created', async () => {
  writeFileSync(join(wt, 'hello.txt'), 'hi\n')
  const sha = await requestGitWrite({
    baseUrl,
    repo: 'repo1',
    taskId: 'am-bd1',
    token: store.token('am-bd1'),
    verb: 'commit',
  })
  expect(sha).toMatch(/^[0-9a-f]{40}$/)
  const created = store.events({ taskId: 'am-bd1' }).find((e) => e.type === 'commit.created')
  expect(created?.type === 'commit.created' ? created.sha : null).toBe(sha)
  expect(git(wt, ['rev-parse', 'HEAD']).stdout.trim()).toBe(sha)
})

test('an unknown verb is rejected before any git write', async () => {
  writeFileSync(join(wt, 'hello.txt'), 'hi\n')
  const res = await fetch(`${baseUrl}/api/repos/repo1/tasks/am-bd1/git-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Amagi-Token': store.token('am-bd1') },
    body: JSON.stringify({ verb: 'push' }),
  })
  expect(res.status).toBe(400)
  expect(git(wt, ['status', '--porcelain']).stdout.trim()).not.toBe('')
  expect(store.events({ taskId: 'am-bd1' }).some((e) => e.type === 'commit.created')).toBe(false)
})

test('a failed request throws so the agent learns immediately', async () => {
  writeFileSync(join(wt, 'hello.txt'), 'hi\n')
  await expect(
    requestGitWrite({
      baseUrl,
      repo: 'repo1',
      taskId: 'am-bd1',
      token: 'wrong-token',
      verb: 'commit',
    }),
  ).rejects.toThrow(/task token mismatch/)
})
