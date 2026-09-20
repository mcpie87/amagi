import { exec as defaultExec, type Exec, execOk } from '../../exec.ts'
import type { GateRef, Question, Tracker, TrackerStatus, TrackerTask } from '../types.ts'

type BdIssue = {
  id: string
  title: string
  description?: string
  status?: string
  priority?: number
  issue_type?: string
  await_type?: string
}

export type BeadsOptions = {
  cwd: string
  exec?: Exec
  /** Recorded in bd's provenance log so agent activity is distinguishable. */
  actor?: string
}

/** bd grants a five minute lease on claim and expects heartbeats under that. */
const LEASE_TTL_MS = 5 * 60_000

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
    const out = await this.bd(['ready', '--json', '--limit', String(limit)])
    return parseIssues(out).map(toTask)
  }

  async claim(id?: string): Promise<TrackerTask | null> {
    if (id !== undefined) {
      await this.bd(['update', id, '--status', 'in_progress'])
      return this.get(id)
    }
    const out = await this.bd(['ready', '--claim', '--json'])
    const issues = parseIssues(out)
    return issues.length > 0 && issues[0] ? toTask(issues[0]) : null
  }

  async get(id: string): Promise<TrackerTask | null> {
    const out = await this.bd(['show', id, '--json'])
    const issues = parseIssues(out)
    return issues.length > 0 && issues[0] ? toTask(issues[0]) : null
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
