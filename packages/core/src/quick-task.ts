import type { CreateTrackerTask, Tracker, TrackerTask } from './drivers/types.ts'

export type QuickTaskDecision =
  | {
      status: 'create'
      title: string
      context: string
      goal: string
      scope: string
      assumptions: string
      acceptance: string
    }
  | { status: 'existing'; id: string }
  | { status: 'fixed'; explanation: string }
  | { status: 'clarification'; question: string }

export type QuickTaskResult =
  | { status: 'issue'; issue: string }
  | Extract<QuickTaskDecision, { status: 'fixed' | 'clarification' }>

export async function quickTaskCandidates(tracker: Tracker): Promise<TrackerTask[]> {
  const ids = tracker.openIds
    ? await tracker.openIds(30)
    : (await tracker.ready(30)).map((t) => t.id)
  const tasks = await Promise.all(ids.map((id) => tracker.get(id)))
  return tasks.filter((task): task is TrackerTask => task !== null)
}

export function parseQuickTaskDecision(raw: string): QuickTaskDecision {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('task drafter returned invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('task drafter returned an invalid result')
  }
  const result = value as Record<string, unknown>
  const nonempty = (key: string): string | null =>
    typeof result[key] === 'string' && result[key].trim() !== '' ? result[key].trim() : null
  if (result.status === 'create') {
    const fields = ['title', 'context', 'goal', 'scope', 'assumptions', 'acceptance'] as const
    if (fields.every((field) => nonempty(field) !== null)) {
      return {
        status: 'create',
        title: nonempty('title') as string,
        context: nonempty('context') as string,
        goal: nonempty('goal') as string,
        scope: nonempty('scope') as string,
        assumptions: nonempty('assumptions') as string,
        acceptance: nonempty('acceptance') as string,
      }
    }
  }
  if (result.status === 'existing' && nonempty('id') !== null)
    return { status: 'existing', id: nonempty('id') as string }
  if (result.status === 'fixed' && nonempty('explanation') !== null)
    return { status: 'fixed', explanation: nonempty('explanation') as string }
  if (result.status === 'clarification' && nonempty('question') !== null)
    return { status: 'clarification', question: nonempty('question') as string }
  throw new Error('task drafter returned an unsupported result')
}

export async function resolveQuickTask(
  tracker: Tracker,
  candidates: readonly TrackerTask[],
  decision: QuickTaskDecision,
): Promise<QuickTaskResult> {
  if (decision.status === 'fixed' || decision.status === 'clarification') return decision
  if (decision.status === 'existing') {
    const task = candidates.find((candidate) => candidate.id === decision.id)
    if (task === undefined) throw new Error('task drafter selected an issue outside the candidates')
    return { status: 'issue', issue: task.url ?? `task ${task.id}` }
  }
  const description = [
    ['Context', decision.context],
    ['Goal', decision.goal],
    ['Scope', decision.scope],
    ['Assumptions', decision.assumptions],
    ['Acceptance', decision.acceptance],
  ]
    .map(([heading, body]) => `## ${heading}\n${body}`)
    .join('\n\n')
  const input: CreateTrackerTask = {
    title: decision.title,
    description,
    acceptanceCriteria: null,
    priority: null,
    labels: [],
    dependencies: [],
    parent: null,
  }
  const task = await tracker.createTask(input)
  return { status: 'issue', issue: task.url ?? `task ${task.id}` }
}
