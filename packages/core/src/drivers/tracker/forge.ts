import { exec as defaultExec, type Exec } from '../../exec.ts'
import {
  ForgeApiError,
  type ForgeEndpoint,
  forgeJson,
  forgePages,
  resolveForge,
} from '../forge-api.ts'
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
  /** The configured forge remote (`[forge] remote`); every API call targets its repository. */
  remote: string
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

function isNotFound(err: unknown): boolean {
  return err instanceof ForgeApiError && err.status === 404
}

/** GitHub and Forgejo share the issue JSON: `number`, `html_url`, RFC 3339 `created_at`. */
function restIssue(raw: Record<string, unknown>): ForgeIssue {
  return {
    id: String(raw.number),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    url: typeof raw.html_url === 'string' ? raw.html_url : null,
    labels: ((raw.labels as Array<{ name?: string }>) ?? []).map((l) => ({ name: l.name ?? '' })),
    createdAt: typeof raw.created_at === 'string' ? Date.parse(raw.created_at) : null,
  }
}

/**
 * Shared Tracker over the forge issue REST API. Neither host has bd's lease or
 * gate primitives: heartbeat is a no-op and a question gate is advisory, an
 * issue comment the runner polls instead of a blocker the tracker enforces.
 */
export abstract class ForgeTracker implements Tracker {
  abstract readonly kind: 'github' | 'forgejo'
  readonly leaseTtlMs = LEASE_TTL_MS
  readonly capabilities: TrackerCapabilities = { create: true, edit: false, dependencies: false }
  protected readonly cwd: string
  protected readonly remote: string
  protected readonly exec: Exec
  private endpoint: ForgeEndpoint | null = null

  constructor(opts: ForgeOptions) {
    this.cwd = opts.cwd
    this.remote = opts.remote
    this.exec = opts.exec ?? defaultExec
  }

  /** Every open issue, pull requests excluded. */
  protected abstract listOpen(): Promise<ForgeIssue[]>
  /** A label's write-API reference: its name, or its id on Forgejo. Null when the repository lacks it. */
  protected abstract labelRef(name: string): Promise<string | number | null>

  async ready(limit = 20): Promise<TrackerTask[]> {
    // Filtered here: the list endpoints can include labels but not exclude them.
    const ready = (await this.listOpen()).filter(
      (i) => !isClaimed(i) && !i.labels.some((label) => label.name === 'proposed'),
    )
    return ready.slice(0, limit).map(toTask)
  }

  async claim(id?: string): Promise<TrackerTask | null> {
    const target = id ?? (await this.ready(1))[0]?.id
    if (target === undefined) return null
    const existing = await this.getIssue(target)
    if (existing === null || existing.labels.some((label) => label.name === 'proposed')) return null
    await this.addClaimLabel(target)
    const issue = await this.getIssue(target)
    return issue === null ? null : toTask(issue)
  }

  async get(id: string): Promise<TrackerTask | null> {
    const issue = await this.getIssue(id)
    return issue === null ? null : toTask(issue)
  }

  async createTask(input: CreateTrackerTask): Promise<TrackerTask> {
    if (input.dependencies.length > 0) {
      throw new Error(`${this.kind} tracker cannot create issues with dependencies`)
    }
    // Forge issues have no priority or parent field, so both are kept as lines in the body.
    const body = [
      input.description,
      ...(input.acceptanceCriteria === null ? [] : [`## Acceptance\n${input.acceptanceCriteria}`]),
      ...(input.parent === null ? [] : [`Parent: #${input.parent}`]),
      ...(input.priority === null ? [] : [`Priority: P${input.priority}`]),
    ].join('\n\n')
    const labels = await Promise.all(input.labels.map((name) => this.writableLabel(name)))
    return toTask(restIssue(await this.api('POST', 'issues', { title: input.title, body, labels })))
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
    return (await this.listOpen()).slice(0, limit).map((i) => i.id)
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

  private async forge(): Promise<ForgeEndpoint> {
    this.endpoint ??= await resolveForge(this.kind, this.cwd, this.remote, this.exec)
    return this.endpoint
  }

  /** One call on `repos/{owner}/{repo}/{rest}`; a body-less answer reads as an empty object. */
  protected async api(
    method: string,
    rest: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const forge = await this.forge()
    const raw = await forgeJson(forge, method, `repos/${forge.ownerRepo}/${rest}`, body)
    return (raw ?? {}) as Record<string, unknown>
  }

  /** Every item of the collection `repos/{owner}/{repo}/{rest}`. */
  protected async pages(rest: string): Promise<Array<Record<string, unknown>>> {
    const forge = await this.forge()
    return forgePages(forge, `repos/${forge.ownerRepo}/${rest}`)
  }

  protected async getIssue(id: string): Promise<ForgeIssue | null> {
    try {
      return restIssue(await this.api('GET', `issues/${id}`))
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  protected async postComment(id: string, body: string): Promise<void> {
    await this.api('POST', `issues/${id}/comments`, { body })
  }

  protected async commentBodies(id: string): Promise<string[]> {
    return (await this.pages(`issues/${id}/comments`)).map((c) => String(c.body ?? ''))
  }

  protected async addClaimLabel(id: string): Promise<void> {
    const label = await this.writableLabel(CLAIM_LABEL)
    await this.api('POST', `issues/${id}/labels`, { labels: [label] })
  }

  protected async removeClaimLabel(id: string): Promise<void> {
    const label = await this.labelRef(CLAIM_LABEL)
    if (label === null) return
    try {
      await this.api('DELETE', `issues/${id}/labels/${encodeURIComponent(String(label))}`)
    } catch (err) {
      // The issue may never have been claimed, so a label that is not on it is not an error.
      if (!isNotFound(err)) throw err
    }
  }

  protected async setState(id: string, closed: boolean): Promise<void> {
    await this.api('PATCH', `issues/${id}`, { state: closed ? 'closed' : 'open' })
  }

  /**
   * Best effort: an existing label, or no right to create one, must not fail
   * the write. A label still missing afterwards fails in writableLabel.
   */
  private async ensureLabel(name: string): Promise<void> {
    await this.api('POST', 'labels', { name, color: 'A0A0A0' }).catch(() => undefined)
  }

  private async writableLabel(name: string): Promise<string | number> {
    await this.ensureLabel(name)
    const label = await this.labelRef(name)
    if (label === null) throw new Error(`${this.kind} has no label ${name} and could not create it`)
    return label
  }
}

export class GithubTracker extends ForgeTracker {
  readonly kind = 'github'

  protected async listOpen(): Promise<ForgeIssue[]> {
    // The issues endpoint also lists pull requests, which are marked by a pull_request key.
    const raw = await this.pages('issues?state=open')
    return raw.filter((i) => !('pull_request' in i)).map(restIssue)
  }

  protected async labelRef(name: string): Promise<string> {
    return name
  }
}

export class ForgejoTracker extends ForgeTracker {
  readonly kind = 'forgejo'

  protected async listOpen(): Promise<ForgeIssue[]> {
    return (await this.pages('issues?state=open&type=issues')).map(restIssue)
  }

  // Forgejo takes label ids on issue and label writes, so names are looked up in the repository.
  protected async labelRef(name: string): Promise<number | null> {
    const label = (await this.pages('labels')).find((l) => l.name === name)
    return typeof label?.id === 'number' ? label.id : null
  }
}
