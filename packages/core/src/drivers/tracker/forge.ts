import { exec as defaultExec, type Exec, execOk } from '../../exec.ts'
import { ghEnv, teaEnv } from '../forge-cred.ts'
import {
  type CreateTrackerTask,
  type GateRef,
  type Question,
  type Tracker,
  type TrackerCapabilities,
  type TrackerStatus,
  type TrackerTask,
  UnsupportedCapabilityError,
  type UpdateTrackerTask,
} from '../types.ts'

export type ForgeOptions = {
  cwd: string
  exec?: Exec
}

/** Neither host has a lease primitive, so a long TTL makes the heartbeat near a no-op. */
const LEASE_TTL_MS = 6 * 60 * 60_000

/** Marks an issue as taken, so a second worker does not claim the same one. */
export const CLAIM_LABEL = 'amagi-claimed'

const QUESTION_MARK = '[amagi] question '
const ANSWER_MARK = '[amagi] answer '

type ForgeIssue = {
  id: string
  title: string
  body: string
  state: 'open' | 'closed'
  url: string | null
  labels: readonly { name: string }[]
  /** Epoch ms; null when the host did not report it. */
  createdAt: number | null
}

function isClaimed(issue: ForgeIssue): boolean {
  return issue.labels.some((l) => l.name === CLAIM_LABEL)
}

function toTask(issue: ForgeIssue): TrackerTask {
  return {
    id: issue.id,
    title: issue.title,
    description: issue.body,
    status: issue.state,
    priority: null,
    type: null,
    url: issue.url,
    ...(issue.createdAt === null ? {} : { createdAt: issue.createdAt }),
  }
}

/** Gate ref encodes task and question so both can be recovered from the id alone. */
function parseGate(ref: GateRef): { taskId: string; questionId: string } {
  const i = ref.id.indexOf('#')
  if (i === -1) throw new Error(`invalid gate ref: ${ref.id}`)
  return { taskId: ref.id.slice(0, i), questionId: ref.id.slice(i + 1) }
}

/**
 * Shared Tracker over gh issue and tea issues. Both lack bd's lease and gate
 * primitives: heartbeat is a no-op and a question gate is advisory, an issue
 * comment the runner polls instead of a blocker the tracker enforces.
 */
export abstract class ForgeTracker implements Tracker {
  abstract readonly kind: string
  readonly leaseTtlMs = LEASE_TTL_MS
  // gh/tea store title, body and labels only; the planned-work fields
  // (acceptance criteria, priority, dependencies) have no forge equivalent,
  // so writes are surfaced as unsupported instead of silently dropping data.
  readonly capabilities: TrackerCapabilities = { create: false, edit: false, dependencies: false }
  protected readonly cwd: string
  protected readonly exec: Exec

  constructor(opts: ForgeOptions) {
    this.cwd = opts.cwd
    this.exec = opts.exec ?? defaultExec
  }

  protected abstract listOpen(limit: number): Promise<ForgeIssue[]>
  protected abstract getIssue(id: string): Promise<ForgeIssue | null>
  protected abstract postComment(id: string, body: string): Promise<void>
  protected abstract commentBodies(id: string): Promise<string[]>
  protected abstract addClaimLabel(id: string): Promise<void>
  protected abstract removeClaimLabel(id: string): Promise<void>
  protected abstract setState(id: string, closed: boolean): Promise<void>

  async ready(limit = 20): Promise<TrackerTask[]> {
    return (await this.listOpen(limit)).filter((i) => !isClaimed(i)).map(toTask)
  }

  async claim(id?: string): Promise<TrackerTask | null> {
    const target = id ?? (await this.ready(1))[0]?.id
    if (target === undefined) return null
    await this.addClaimLabel(target)
    const issue = await this.getIssue(target)
    return issue === null ? null : toTask(issue)
  }

  async get(id: string): Promise<TrackerTask | null> {
    const issue = await this.getIssue(id)
    return issue === null ? null : toTask(issue)
  }

  async createTask(_input: CreateTrackerTask): Promise<TrackerTask> {
    throw new UnsupportedCapabilityError('create', this.kind)
  }

  async updateTask(_id: string, _input: UpdateTrackerTask): Promise<TrackerTask> {
    throw new UnsupportedCapabilityError('edit', this.kind)
  }

  async heartbeat(_id: string): Promise<boolean> {
    return true
  }

  async comment(id: string, body: string): Promise<void> {
    await this.postComment(id, body)
  }

  async setStatus(id: string, status: TrackerStatus): Promise<void> {
    if (status === 'closed') return this.setState(id, true)
    if (status === 'open') return this.setState(id, false)
    // in_progress/blocked: no forge equivalent; the claim label already marks it
  }

  async release(id: string): Promise<void> {
    await this.removeClaimLabel(id)
  }

  async openIds(limit = 500): Promise<string[]> {
    return (await this.listOpen(limit)).map((i) => i.id)
  }

  async close(id: string, _reason?: string): Promise<void> {
    await this.setState(id, true)
  }

  async openGate(taskId: string, question: Question): Promise<GateRef> {
    const options =
      question.options.length > 0 ? `\n\nOptions: ${question.options.join(' | ')}` : ''
    await this.postComment(taskId, `${QUESTION_MARK}${question.id}\n\n${question.text}${options}`)
    return { id: `${taskId}#${question.id}`, advisory: true }
  }

  async gateResolved(ref: GateRef): Promise<boolean> {
    const { taskId, questionId } = parseGate(ref)
    const issue = await this.getIssue(taskId)
    if (issue === null || issue.state === 'closed') return true
    const bodies = await this.commentBodies(taskId)
    return bodies.some((b) => b.includes(`${ANSWER_MARK}${questionId}`))
  }

  async resolveGate(ref: GateRef): Promise<void> {
    const { taskId, questionId } = parseGate(ref)
    await this.postComment(taskId, `${ANSWER_MARK}${questionId}`)
  }
}

const GH_FIELDS = 'number,title,body,state,url,labels,createdAt'

function ghIssue(raw: Record<string, unknown>): ForgeIssue {
  return {
    id: String(raw.number),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    state: raw.state === 'CLOSED' ? 'closed' : 'open',
    url: typeof raw.url === 'string' ? raw.url : null,
    labels: ((raw.labels as Array<{ name?: string }>) ?? []).map((l) => ({ name: l.name ?? '' })),
    createdAt: typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : null,
  }
}

export class GithubTracker extends ForgeTracker {
  readonly kind = 'github'

  protected async listOpen(limit: number): Promise<ForgeIssue[]> {
    const out = await execOk(
      this.exec,
      ['gh', 'issue', 'list', '--state', 'open', '--limit', String(limit), '--json', GH_FIELDS],
      { cwd: this.cwd, env: ghEnv() },
    )
    return (JSON.parse(out) as Array<Record<string, unknown>>).map(ghIssue)
  }

  protected async getIssue(id: string): Promise<ForgeIssue | null> {
    const out = await execOk(this.exec, ['gh', 'issue', 'view', id, '--json', GH_FIELDS], {
      cwd: this.cwd,
      env: ghEnv(),
    })
    return ghIssue(JSON.parse(out) as Record<string, unknown>)
  }

  protected async postComment(id: string, body: string): Promise<void> {
    await execOk(this.exec, ['gh', 'issue', 'comment', id, '--body-file', '-'], {
      cwd: this.cwd,
      stdin: body,
      env: ghEnv(),
    })
  }

  protected async commentBodies(id: string): Promise<string[]> {
    const out = await execOk(this.exec, ['gh', 'issue', 'view', id, '--json', 'comments'], {
      cwd: this.cwd,
      env: ghEnv(),
    })
    const parsed = JSON.parse(out) as { comments?: Array<{ body?: string }> }
    return (parsed.comments ?? []).map((c) => c.body ?? '')
  }

  protected async addClaimLabel(id: string): Promise<void> {
    await this.ensureClaimLabel()
    await execOk(this.exec, ['gh', 'issue', 'edit', id, '--add-label', CLAIM_LABEL], {
      cwd: this.cwd,
      env: ghEnv(),
    })
  }

  protected async removeClaimLabel(id: string): Promise<void> {
    await execOk(this.exec, ['gh', 'issue', 'edit', id, '--remove-label', CLAIM_LABEL], {
      cwd: this.cwd,
      env: ghEnv(),
    })
  }

  protected async setState(id: string, closed: boolean): Promise<void> {
    await execOk(this.exec, closed ? ['gh', 'issue', 'close', id] : ['gh', 'issue', 'reopen', id], {
      cwd: this.cwd,
      env: ghEnv(),
    })
  }

  private async ensureClaimLabel(): Promise<void> {
    // --force makes create idempotent; failure (e.g. no write perms) is best effort
    await this.exec(['gh', 'label', 'create', CLAIM_LABEL, '--force'], {
      cwd: this.cwd,
      env: ghEnv(),
    })
  }
}

const TEA_FIELDS = 'index,state,title,body,url,labels,created'

function teaIssue(raw: Record<string, unknown>): ForgeIssue {
  return {
    id: String(raw.index),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.url === 'string' ? raw.url : null,
    labels: ((raw.labels as Array<{ name?: string }>) ?? []).map((l) => ({ name: l.name ?? '' })),
    // gitea/forgejo report creation as a Unix timestamp in seconds
    createdAt: typeof raw.created === 'number' && raw.created > 0 ? raw.created * 1000 : null,
  }
}

export class ForgejoTracker extends ForgeTracker {
  readonly kind = 'forgejo'

  protected async listOpen(limit: number): Promise<ForgeIssue[]> {
    const out = await execOk(
      this.exec,
      [
        'tea',
        'issues',
        'list',
        '--state',
        'open',
        '--limit',
        String(limit),
        '--fields',
        TEA_FIELDS,
        '--output',
        'json',
      ],
      { cwd: this.cwd, env: await teaEnv(this.exec, this.cwd) },
    )
    const parsed = JSON.parse(out)
    return (Array.isArray(parsed) ? parsed : []).map(teaIssue)
  }

  protected async getIssue(id: string): Promise<ForgeIssue | null> {
    const out = await execOk(
      this.exec,
      ['tea', 'issues', id, '--fields', TEA_FIELDS, '--output', 'json'],
      { cwd: this.cwd, env: await teaEnv(this.exec, this.cwd) },
    )
    return teaIssue(JSON.parse(out) as Record<string, unknown>)
  }

  protected async postComment(id: string, body: string): Promise<void> {
    await execOk(this.exec, ['tea', 'comments', 'add', id, '--description', body], {
      cwd: this.cwd,
      env: await teaEnv(this.exec, this.cwd),
    })
  }

  protected async commentBodies(id: string): Promise<string[]> {
    const out = await execOk(this.exec, ['tea', 'comments', 'list', id, '--output', 'json'], {
      cwd: this.cwd,
      env: await teaEnv(this.exec, this.cwd),
    })
    const parsed = JSON.parse(out) as Array<{ content?: string; body?: string }>
    return parsed.map((c) => c.content ?? c.body ?? '')
  }

  protected async addClaimLabel(id: string): Promise<void> {
    await this.ensureClaimLabel()
    await execOk(this.exec, ['tea', 'issues', 'edit', id, '--add-labels', CLAIM_LABEL], {
      cwd: this.cwd,
      env: await teaEnv(this.exec, this.cwd),
    })
  }

  protected async removeClaimLabel(id: string): Promise<void> {
    await execOk(this.exec, ['tea', 'issues', 'edit', id, '--remove-labels', CLAIM_LABEL], {
      cwd: this.cwd,
      env: await teaEnv(this.exec, this.cwd),
    })
  }

  protected async setState(id: string, closed: boolean): Promise<void> {
    await execOk(
      this.exec,
      closed ? ['tea', 'issues', 'close', id] : ['tea', 'issues', 'reopen', id],
      { cwd: this.cwd, env: await teaEnv(this.exec, this.cwd) },
    )
  }

  private async ensureClaimLabel(): Promise<void> {
    // best effort: creating an existing label fails, which is fine
    await this.exec(['tea', 'labels', 'create', '--name', CLAIM_LABEL, '--color', 'A0A0A0'], {
      cwd: this.cwd,
      env: await teaEnv(this.exec, this.cwd),
    })
  }
}
