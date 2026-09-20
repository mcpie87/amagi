import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openDatabase, type QuestionRow, Store } from '@amagi/core'
import { serve } from '../../server/src/serve.ts'
import { askQuestion, taskIdFromBranch } from './ask.ts'

let store: Store
let server: ReturnType<typeof serve>
let baseUrl: string

const claim = (id: string) =>
  store.append(id, { type: 'task.claimed', title: `work on ${id}`, tracker: 'beads' })
const implementing = (id: string) => {
  for (const to of ['worktree_ready', 'implementing'] as const) {
    store.append(id, { type: 'task.state', from: null, to })
  }
}

const waitForQuestion = async (taskId: string): Promise<QuestionRow> => {
  for (let i = 0; i < 500; i++) {
    const q = store.openQuestions(taskId)[0]
    if (q) return q
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error('question never landed')
}

beforeEach(() => {
  store = new Store(openDatabase(':memory:'))
  server = serve({ store, host: '127.0.0.1', port: 0 })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server.stop(true)
  store.close()
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
    taskId: 'bd-1',
    token,
    question: 'which registry?',
    options: ['npm', 'nexus'],
    deadlineMs: 2000,
  })
  const q = await waitForQuestion('bd-1')
  const res = await fetch(`${baseUrl}/api/tasks/bd-1/questions/${q.id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
    body: JSON.stringify({ answer: 'npm' }),
  })
  expect(res.status).toBe(200)

  expect(await pending).toEqual({ kind: 'answered', answer: 'npm' })
})

test('timed out: reports no answer yet and parks the task', async () => {
  claim('bd-1')
  implementing('bd-1')
  const token = store.token('bd-1')

  const outcome = await askQuestion({
    baseUrl,
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
