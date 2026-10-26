import type { Store } from '@amagi/core'
import { fetchOperatorSecret, submitAnswer } from '@amagi/tui/answer'

export async function answerQuestion(
  baseUrl: string,
  repo: string,
  store: Store,
  questionId: string,
  answer: string,
): Promise<{ kind: 'ok' } | { kind: 'error'; message: string }> {
  const question = store.question(questionId)
  if (!question) return { kind: 'error', message: `unknown question ${questionId}` }

  const secret = await fetchOperatorSecret(baseUrl)
  if (!secret) return { kind: 'error', message: 'could not get the operator secret from amagi' }

  return submitAnswer(baseUrl, repo, question.taskId, questionId, secret, answer)
}
