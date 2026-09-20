import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openDatabase, type QuestionRow, Store } from '@amagi/core'
import { serve } from '../../server/src/serve.ts'
import { answerQuestion, askQuestion, listOpenQuestions, taskIdFromBranch } from './ask.ts'

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

test('answerQuestion answers and unparks the task', async () => {
  claim('bd-1')
  implementing('bd-1')
  const token = store.token('bd-1')
  store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'awaiting_answer' })
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which registry?',
    options: ['npm', 'nexus'],
    gateRef: null,
  })

  const question = await answerQuestion({
    baseUrl,
    questionId: 'q1',
    taskId: 'bd-1',
    token,
    answer: 'npm',
  })

  expect(question.answer).toBe('npm')
  expect(question.answeredVia).toBe('cli')
  expect(store.task('bd-1')?.state).toBe('implementing')
})

test('answerQuestion rejects a token mismatch', async () => {
  claim('bd-1')
  implementing('bd-1')
  store.append('bd-1', { type: 'task.state', from: 'implementing', to: 'awaiting_answer' })
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which registry?',
    options: [],
    gateRef: null,
  })

  await expect(
    answerQuestion({
      baseUrl,
      questionId: 'q1',
      taskId: 'bd-1',
      token: 'wrong-token',
      answer: 'npm',
    }),
  ).rejects.toThrow(/token mismatch/)
})

test('listOpenQuestions returns only unresolved questions', async () => {
  claim('bd-1')
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q1',
    question: 'which registry?',
    options: ['npm', 'nexus'],
    gateRef: null,
  })
  store.append('bd-1', {
    type: 'question.asked',
    questionId: 'q2',
    question: 'which color?',
    options: [],
    gateRef: null,
  })
  store.append('bd-1', { type: 'question.answered', questionId: 'q1', answer: 'npm', via: 'cli' })

  const questions = await listOpenQuestions(baseUrl)
  expect(questions.map((q) => q.id)).toEqual(['q2'])
  expect(questions[0]?.taskId).toBe('bd-1')
})
