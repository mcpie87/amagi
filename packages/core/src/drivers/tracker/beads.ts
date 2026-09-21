import { exec as defaultExec, type Exec, execOk } from '../../exec.ts'
import type {
  CreateTrackerTask,
  GateRef,
  Question,
  Tracker,
  TrackerCapabilities,
  TrackerStatus,
  TrackerTask,
  UpdateTrackerTask,
} from '../types.ts'

type BdIssue = {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  status?: string
  priority?: number
  issue_type?: string
  assignee?: string
  labels?: string[]
  parent?: string
  dependencies?: BdIssue[]
}

export type BeadsIssue = TrackerTask & {
  acceptanceCriteria: string | null
  assignee: string | null
  labels: string[]
  parent: string | null
  /** Issues this one is blocked by, when the tracker reports them (bd show does). */
  dependencies: TrackerTask[]
}

export type BeadsOptions = {
  cwd: string
  exec?: Exec
  /** Recorded in bd's provenance log so agent activity is distinguishable. */
  actor?: string
}

/** bd grants a five minute lease on claim and expects heartbeats under that. */
const LEASE_TTL_MS = 5 * 60_000

/**
 * Containers and coordination primitives, not work. bd reports them as ready,
 * so without this an agent is handed an epic title and told to implement it.
 */
const NOT_WORK_TYPES = ['epic', 'milestone', 'gate'] as const

/** Opt out marker for work that is the operator's to do, not an agent's. */
export const HUMAN_ONLY_LABEL = 'human'

const STATUS_MAP: Record<string, TrackerStatus> = {
  open: 'open',
  in_progress: 'in_progress',
  blocked: 'blocked',
  closed: 'closed',
}

function toTask(issue: BdIssue): TrackerTask {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description ?? '',
    status: STATUS_MAP[issue.status ?? 'open'] ?? 'open',
    priority: issue.priority ?? null,
    type: issue.issue_type ?? null,
    url: null,
  }
}

function toIssue(issue: BdIssue): BeadsIssue {
  return {
    ...toTask(issue),
    acceptanceCriteria: issue.acceptance_criteria ?? null,
    assignee: issue.assignee ?? null,
    labels: issue.labels ?? [],
    parent: issue.parent ?? null,
    dependencies: (issue.dependencies ?? []).map(toTask),
  }
}

/** bd prints `[]` rather than nothing when a query matches no issues. */
function parseIssues(stdout: string): BdIssue[] {
  const trimmed = stdout.trim()
  if (trimmed === '') return []
  const parsed: unknown = JSON.parse(trimmed)
  return Array.isArray(parsed) ? (parsed as BdIssue[]) : [parsed as BdIssue]
}

export class BeadsTracker implements Tracker {
  readonly kind = 'beads'
  readonly leaseTtlMs = LEASE_TTL_MS
  readonly capabilities: TrackerCapabilities = { create: true, edit: true, dependencies: true }

  private readonly cwd: string
  private readonly exec: Exec
  private readonly actor: string | undefined

  constructor(opts: BeadsOptions) {
    this.cwd = opts.cwd
    this.exec = opts.exec ?? defaultExec
    this.actor = opts.actor
  }

  private args(rest: string[]): string[] {
    return this.actor ? ['bd', '--actor', this.actor, ...rest] : ['bd', ...rest]
  }

  private async bd(rest: string[]): Promise<string> {
    return execOk(this.exec, this.args(rest), { cwd: this.cwd })
  }

  async ready(limit = 20): Promise<TrackerTask[]> {
    const out = await this.bd([
      'ready',
      '--json',
      '--limit',
      String(limit),
      '--exclude-type',
      NOT_WORK_TYPES.join(','),
      '--exclude-label',
      HUMAN_ONLY_LABEL,
    ])
    return parseIssues(out).map(toTask)
  }

  async list(limit = 200): Promise<BeadsIssue[]> {
    return parseIssues(await this.bd(['list', '--json', '--limit', String(limit)])).map(toIssue)
  }

  async getIssue(id: string): Promise<BeadsIssue | null> {
    const issues = parseIssues(await this.bd(['show', id, '--json']))
    return issues.length > 0 && issues[0] ? toIssue(issues[0]) : null
  }

  async claim(id?: string): Promise<TrackerTask | null> {
    if (id !== undefined) {
      await this.bd(['update', id, '--status', 'in_progress'])
      return this.get(id)
    }
    const out = await this.bd([
      'ready',
      '--claim',
      '--json',
      '--exclude-type',
      NOT_WORK_TYPES.join(','),
      '--exclude-label',
      HUMAN_ONLY_LABEL,
    ])
    const issues = parseIssues(out)
    return issues.length > 0 && issues[0] ? toTask(issues[0]) : null
  }

  async get(id: string): Promise<TrackerTask | null> {
    const out = await this.bd(['show', id, '--json'])
    const issues = parseIssues(out)
    return issues.length > 0 && issues[0] ? toTask(issues[0]) : null
  }

  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    const args = [
      'create',
      '--title',
      input.title,
      '--json',
      ...(input.description === '' ? [] : ['--description', input.description]),
      ...(input.acceptanceCriteria === null ? [] : ['--acceptance', input.acceptanceCriteria]),
      ...(input.priority === null ? [] : ['--priority', `P${input.priority}`]),
      ...(input.labels.length === 0 ? [] : ['--labels', input.labels.join(',')]),
      ...(input.dependencies.length === 0 ? [] : ['--deps', input.dependencies.join(',')]),
    ]
    const issues = parseIssues(await this.bd(args))
    const created = issues[0]
    if (created === undefined) throw new Error('bd create returned no issue')
    return toTask(created)
  }

  async updateTask(id: string, input: UpdateTrackerTask): Promise<TrackerTask> {
    const update: string[] = []
    if (input.title !== undefined) update.push('--title', input.title)
    if (input.description !== undefined) update.push('--description', input.description)
    if (input.acceptanceCriteria !== undefined) {
      update.push('--acceptance', input.acceptanceCriteria ?? '')
    }
    if (input.priority !== undefined && input.priority !== null) {
      update.push('--priority', `P${input.priority}`)
    }
    if (input.labels !== undefined) update.push('--set-labels', input.labels.join(','))
    if (update.length > 0) await this.bd(['update', id, ...update])
    if (input.dependencies !== undefined) {
      for (const dep of input.dependencies.add) await this.bd(['dep', 'add', id, dep])
      for (const dep of input.dependencies.remove) await this.bd(['dep', 'remove', id, dep])
    }
    const updated = await this.get(id)
    if (updated === null) throw new Error(`bd: issue ${id} disappeared after update`)
    return updated
  }

  async heartbeat(id: string): Promise<boolean> {
    const result = await this.exec(this.args(['heartbeat', id]), { cwd: this.cwd })
    return result.exitCode === 0
  }

  async comment(id: string, body: string): Promise<void> {
    await execOk(this.exec, this.args(['comment', id, '--stdin']), { cwd: this.cwd, stdin: body })
  }

  async setStatus(id: string, status: TrackerStatus): Promise<void> {
    if (status === 'closed') return this.close(id)
    await this.bd(['update', id, '--status', status])
  }

  async release(id: string): Promise<void> {
    await this.bd(['unclaim', id])
  }

  async close(id: string, reason?: string): Promise<void> {
    await this.bd(reason === undefined ? ['close', id] : ['close', id, '--reason', reason])
  }

  /**
   * `bd gate create` has no --json and only prints the new id in prose, so the
   * gate is tagged with the question id in its title and looked up afterwards.
   * That survives a change to the success message.
   */
  async openGate(taskId: string, question: Question): Promise<GateRef> {
    const title = gateTitle(question.id)
    const reason =
      question.options.length > 0
        ? `${question.text}\n\nOptions: ${question.options.join(' | ')}`
        : question.text

    await this.bd([
      'gate',
      'create',
      '--blocks',
      taskId,
      '--type',
      'human',
      '--title',
      title,
      '--reason',
      reason,
    ])

    const gates = parseIssues(await this.bd(['gate', 'list', taskId, '--json']))
    const match = gates.find((g) => g.title === title)
    if (!match) throw new Error(`bd: gate for question ${question.id} was not found after creation`)
    return { id: match.id, advisory: false }
  }

  async gateResolved(ref: GateRef): Promise<boolean> {
    const issue = await this.get(ref.id)
    return issue === null || issue.status === 'closed'
  }

  async resolveGate(ref: GateRef): Promise<void> {
    await this.bd(['gate', 'resolve', ref.id])
  }
}

export function gateTitle(questionId: string): string {
  return `amagi question ${questionId}`
}
