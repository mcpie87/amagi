import type { Store } from '@amagi/core'
import { fetchTaskToken, submitAnswer } from '@amagi/tui/answer'

export async function answerQuestion(
  baseUrl: string,
  store: Store,
  questionId: string,
  answer: string,
): Promise<{ kind: 'ok' } | { kind: 'error'; message: string }> {
  const question = store.question(questionId)
  if (!question) return { kind: 'error', message: `unknown question ${questionId}` }

  const token = await fetchTaskToken(baseUrl, question.taskId)
  if (!token) return { kind: 'error', message: `could not get task token for ${question.taskId}` }

  return submitAnswer(baseUrl, question.taskId, questionId, token, answer)
}
