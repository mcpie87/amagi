export type AskOutcome = { kind: 'answered'; answer: string } | { kind: 'no_answer' }

export type AskOptions = {
  baseUrl: string
  repo: string
  taskId: string
  token: string
  question: string
  options: string[]
  deadlineMs: number
}

export { taskIdFromBranch } from '@amagi/core'

async function errorOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function askQuestion(opts: AskOptions): Promise<AskOutcome> {
  const headers = { 'content-type': 'application/json', 'X-Amagi-Token': opts.token }
  const base = `${opts.baseUrl}/api/repos/${opts.repo}/tasks/${opts.taskId}`

  const asked = await fetch(`${base}/questions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ question: opts.question, options: opts.options }),
  })
  if (!asked.ok) throw new Error(`amagi ask: ${await errorOf(asked)}`)
  const question = ((await asked.json()) as { question: { id: string } }).question

  const awaited = await fetch(
    `${base}/questions/${question.id}/await?deadlineMs=${opts.deadlineMs}`,
    { headers },
  )
  if (!awaited.ok) throw new Error(`amagi ask: ${await errorOf(awaited)}`)
  const answer = ((await awaited.json()) as { question: { answer: string | null } }).question.answer

  return answer === null ? { kind: 'no_answer' } : { kind: 'answered', answer }
}
