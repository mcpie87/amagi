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
  metadata?: Record<string, string>
}

/** A blocker behind a BeadsIssue, with the labels the dashboard needs to tell
 * dependency blockers from human-only ones (`human` label). */
export type BeadsBlocker = TrackerTask & {
  labels: string[]
}

export type BeadsIssue = TrackerTask & {
  acceptanceCriteria: string | null
  assignee: string | null
  labels: string[]
  parent: string | null
  /** Issues this one is blocked by, when the tracker reports them (bd show does). */
  dependencies: BeadsBlocker[]
}

export type BeadsOptions = {
  cwd: string
  exec?: Exec
  /** Recorded in bd's provenance log so agent activity is distinguishable. */
  actor?: string
}

/** One epic from `bd epic close-eligible --dry-run`, the preview surface. */
export type EpicCloseEligible = {
  id: string
  title: string
  status: string
  totalChildren: number
  closedChildren: number
}

/** What `bd epic close-eligible` actually closed. */
export type EpicCloseResult = {
  closed: string[]
  reason: string
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
  const difficulty = issue.metadata?.difficulty
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description ?? '',
    status: STATUS_MAP[issue.status ?? 'open'] ?? 'open',
    priority: issue.priority ?? null,
    type: issue.issue_type ?? null,
    url: null,
    ...(typeof difficulty === 'string' && difficulty !== '' ? { difficulty } : {}),
  }
}

function toIssue(issue: BdIssue): BeadsIssue {
  return {
    ...toTask(issue),
    acceptanceCriteria: issue.acceptance_criteria ?? null,
    assignee: issue.assignee ?? null,
    labels: issue.labels ?? [],
    parent: issue.parent ?? null,
    dependencies: (issue.dependencies ?? []).map((d) => ({
      ...toTask(d),
      labels: d.labels ?? [],
    })),
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
    return parseIssues(await this.bd(['list', '--all', '--json', '--limit', String(limit)])).map(
      toIssue,
    )
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
    const claimed = issues[0]
    if (claimed !== undefined) return toTask(claimed)
    // bd 1.3.0's ready --claim skips open issues already assigned to the
    // claiming actor, even though `bd ready` lists them, so a queue of such
    // issues would report nothing ready forever. Claim the first by id.
    const ready = await this.ready(1)
    const first = ready[0]
    if (first === undefined) return null
    return this.claim(first.id)
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
      ...(input.difficulty === undefined || input.difficulty === null
        ? []
        : ['--metadata', JSON.stringify({ difficulty: input.difficulty })]),
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

  /** Preview: epics whose children are all complete (bd epic close-eligible --dry-run). */
  async eligibleEpics(): Promise<EpicCloseEligible[]> {
    const out = await this.bd(['epic', 'close-eligible', '--dry-run', '--json'])
    const parsed: unknown = JSON.parse(out)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
      .filter((e) => e.eligible_for_close === true)
      .map((e) => {
        const epic = (e.epic ?? {}) as Record<string, unknown>
        return {
          id: String(epic.id ?? ''),
          title: String(epic.title ?? ''),
          status: String(epic.status ?? ''),
          totalChildren: Number(e.total_children ?? 0),
          closedChildren: Number(e.closed_children ?? 0),
        }
      })
  }

  /** Close the eligible epics, recording the operator's reason (bd epic close-eligible --reason). */
  async closeEligibleEpics(reason: string): Promise<EpicCloseResult> {
    const out = await this.bd(['epic', 'close-eligible', '--reason', reason, '--json'])
    const parsed = (JSON.parse(out) ?? {}) as { closed?: unknown; reason?: unknown }
    return {
      closed: Array.isArray(parsed.closed) ? parsed.closed.map(String) : [],
      reason: String(parsed.reason ?? ''),
    }
  }
}

export function gateTitle(questionId: string): string {
  return `amagi question ${questionId}`
}
