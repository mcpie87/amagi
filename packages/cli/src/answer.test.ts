import { afterEach, beforeEach, expect, test } from 'bun:test'
import { serve } from '../../server/src/serve.ts'
import { type TestWorkspaces, testWorkspaces } from '../../server/src/test-util.ts'
import { answerQuestion } from './answer.ts'

let ws: TestWorkspaces
let store: import('@amagi/core').Store
let server: ReturnType<typeof serve>
let baseUrl: string

beforeEach(() => {
  ws = testWorkspaces(['repo1'])
  store = ws.store('repo1')
  store.append('am-1', { type: 'task.claimed', title: 'implement feature', tracker: 'beads' })
  store.append('am-1', { type: 'task.state', from: null, to: 'worktree_ready' })
  store.append('am-1', { type: 'task.state', from: 'worktree_ready', to: 'implementing' })
  store.append('am-1', {
    type: 'question.asked',
    questionId: 'q-1',
    question: 'Which package manager?',
    options: ['npm', 'bun'],
    gateRef: null,
  })
  server = serve({ workspaces: ws.workspaces, host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop(true)
  ws.cleanup()
})

test('answers a waiting question through the server', async () => {
  const outcome = await answerQuestion(baseUrl, 'repo1', store, 'q-1', 'bun')

  expect(outcome).toEqual({ kind: 'ok' })
  expect(store.question('q-1')?.answer).toBe('bun')
  expect(store.question('q-1')?.answeredVia).toBe('cli')
  expect(store.task('am-1')?.state).toBe('implementing')
})

test('rejects an unknown question id', async () => {
  await expect(answerQuestion(baseUrl, 'repo1', store, 'missing', 'bun')).resolves.toEqual({
    kind: 'error',
    message: 'unknown question missing',
  })
})
