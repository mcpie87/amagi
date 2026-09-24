import type { AgentProcess, Config, Harness } from '@amagi/core'
import type { Picker } from './select-run.ts'

export type DraftTask = {
  title: string
  description: string
}

export type DraftOutput =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'task'; title: string; description: string }

/** Ceiling on the clarify/answer loop so a stuck agent cannot spin forever. */
export const MAX_DRAFT_ROUNDS = 8

export function draftPrompt(idea: string): string {
  return [
    'You are drafting a task for the amagi orchestrator, which runs AI coding agents',
    'against a beads issue tracker. The user wants this done:',
    '',
    idea,
    '',
    'Produce the task as JSON. If you need clarification first, respond with ONLY:',
    '{"questions": ["one", "two"]}',
    'When the task is fully specified, respond with ONLY:',
    '{"title": "...", "description": "..."}',
    'The title is short and imperative; the description is a markdown spec with',
    'acceptance criteria. Respond with nothing but the JSON.',
  ].join('\n')
}

export function answerPrompt(answers: string[]): string {
  return [
    'The user answered your clarifying questions:',
    '',
    ...answers,
    '',
    'Continue drafting the task. Same output rules apply: questions JSON, or the final task JSON.',
  ].join('\n')
}

function lastJsonBlock(text: string): string | null {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const blocks = [...candidates(stripped, '{', '}'), ...candidates(stripped, '[', ']')]
  blocks.sort((a, b) => b.length - a.length)
  return blocks[0] ?? null
}

function candidates(text: string, open: string, close: string): string[] {
  const out: string[] = []
  let i = text.lastIndexOf(open)
  while (i !== -1) {
    const end = text.indexOf(close, i)
    if (end !== -1) out.push(text.slice(i, end + 1))
    // lastIndexOf clamps a negative position to 0, so stop once the match is at 0.
    if (i === 0) break
    i = text.lastIndexOf(open, i - 1)
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parses the agent's final answer into questions or a finished task draft. */
export function parseDraftOutput(text: string): DraftOutput | null {
  const block = lastJsonBlock(text)
  if (block === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  if (
    Array.isArray(parsed.questions) &&
    parsed.questions.length > 0 &&
    parsed.questions.every((q) => typeof q === 'string' && q.trim() !== '')
  ) {
    return { kind: 'questions', questions: parsed.questions.map((q) => String(q).trim()) }
  }
  if (typeof parsed.title === 'string' && parsed.title.trim() !== '') {
    return {
      kind: 'task',
      title: parsed.title.trim(),
      description: typeof parsed.description === 'string' ? parsed.description : '',
    }
  }
  return null
}

/**
 * Drives a back-and-forth with the picked harness to turn a rough idea into a
 * beads task: the agent asks clarifying questions (answered on the terminal),
 * then emits the final title + description.
 */
export async function draftTask(
  harness: Harness,
  implement: Config['harness']['implement'],
  idea: string,
  picker: Pick<Picker, 'input'>,
  cwd: string,
): Promise<DraftTask> {
  let sessionId: string | null = null
  let prompt = draftPrompt(idea)
  const opts = {
    cwd,
    ...(implement.seat === undefined ? {} : { seat: implement.seat }),
    ...(implement.model === undefined ? {} : { model: implement.model }),
    ...(implement.effort === undefined ? {} : { effort: implement.effort }),
    permissions: implement.permissions,
    extraArgs: implement.extraArgs,
  }

  for (let round = 0; round < MAX_DRAFT_ROUNDS; round++) {
    const proc: AgentProcess =
      sessionId === null
        ? harness.start({ ...opts, prompt })
        : harness.resume(sessionId, { ...opts, prompt })

    const text: string[] = []
    for await (const event of proc.events()) {
      if (event.kind === 'text' && event.text.trim()) text.push(event.text)
    }
    const outcome = await proc.done
    if (outcome.sessionId !== null) sessionId = outcome.sessionId
    if (!outcome.ok)
      throw new Error(`draft agent failed: ${outcome.stderr.trim() || `exit ${outcome.exitCode}`}`)

    const output = parseDraftOutput(text.join('\n'))
    if (output === null) throw new Error('draft agent produced no parsable task JSON')

    if (output.kind === 'task') return { title: output.title, description: output.description }

    const answers: string[] = []
    for (const question of output.questions) {
      const answer = await picker.input(question)
      if (answer === null) throw new Error('draft cancelled')
      answers.push(`Q: ${question}\nA: ${answer}`)
    }
    prompt = answerPrompt(answers)
  }
  throw new Error(`draft did not converge within ${MAX_DRAFT_ROUNDS} rounds`)
}
