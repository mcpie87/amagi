import { errorOf } from '@amagi/core'

export type AnswerOutcome = { kind: 'ok' } | { kind: 'error'; message: string }

/** The task token gates the answer endpoint; the task detail is the only channel that hands it out. */
export async function fetchTaskToken(
  baseUrl: string,
  repo: string,
  taskId: string,
): Promise<string | null> {
  const res = await fetch(`${baseUrl}/api/repos/${repo}/tasks/${taskId}`)
  if (!res.ok) return null
  const body = (await res.json()) as { token?: string }
  return body.token ?? null
}

export async function submitAnswer(
  baseUrl: string,
  repo: string,
  taskId: string,
  questionId: string,
  token: string,
  answer: string,
): Promise<AnswerOutcome> {
  const res = await fetch(
    `${baseUrl}/api/repos/${repo}/tasks/${taskId}/questions/${questionId}/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
      body: JSON.stringify({ answer, via: 'cli' }),
    },
  )
  if (!res.ok) return { kind: 'error', message: await errorOf(res) }
  return { kind: 'ok' }
}
