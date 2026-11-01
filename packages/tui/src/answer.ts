import { errorOf, operatorSessionPath } from '@amagi/core'

export type AnswerOutcome = { kind: 'ok' } | { kind: 'error'; message: string }

export async function fetchOperatorSecret(baseUrl: string): Promise<string | null> {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:') return null
    const state = JSON.parse(await Bun.file(operatorSessionPath()).text()) as {
      secret?: unknown
      port?: unknown
      host?: unknown
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const configured = typeof state.host === 'string' && url.hostname === state.host
    return (local || configured) &&
      typeof state.secret === 'string' &&
      Number(url.port || 80) === state.port
      ? state.secret
      : null
  } catch {
    return null
  }
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
