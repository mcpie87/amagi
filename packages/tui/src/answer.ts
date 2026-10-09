import { errorOf } from '@amagi/core'

export type AnswerOutcome = { kind: 'ok' } | { kind: 'error'; message: string }

/** The operator secret gates mutating routes; the session endpoint hands it to local clients. */
export async function fetchOperatorSecret(baseUrl: string): Promise<string | null> {
  const res = await fetch(`${baseUrl}/api/session`)
  if (!res.ok) return null
  const body = (await res.json()) as { secret?: string }
  return body.secret ?? null
}

export async function submitAnswer(
  baseUrl: string,
  repo: string,
  taskId: string,
  questionId: string,
  secret: string,
  answer: string,
): Promise<AnswerOutcome> {
  const res = await fetch(
    `${baseUrl}/api/repos/${repo}/tasks/${taskId}/questions/${questionId}/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Amagi-Secret': secret },
      body: JSON.stringify({ answer, via: 'cli' }),
    },
  )
  if (!res.ok) return { kind: 'error', message: await errorOf(res) }
  return { kind: 'ok' }
}
