import type { MergeStatus } from '../events.ts'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'
import type { PrInfo, PrMergeStatus } from '../pr-check.ts'
import { forgeToken, ghEnv, gitTokenConfig, parseRemote } from './forge-cred.ts'

export type PullRequest = { url: string; number: number }

/** Remote lifecycle of a pull request, for reconciling parked tasks. */
export type PrState = 'open' | 'closed' | 'merged'

/** A PR conversation comment, review summary, or inline review comment. */
export type PrComment = { id: string; user: string; body: string }

/** Marks a PR as agent-generated, so humans can tell it from their own. */
export const AMAGI_LABEL = 'amagi'

/**
 * Marks an agent PR as pointless (empty diff against base). Owned by the
 * watcher in both directions: added when the PR qualifies, removed when it
 * stops, so a human closing the PR is the only terminal step.
 */
export const NEEDS_CLOSING_LABEL = 'amagi/needs-closing'

/** Provenance plus an amagi/<type> intent label mirroring the source task. */
export function amagiLabels(type: string | null): string[] {
  return type === null || type === '' ? [AMAGI_LABEL] : [AMAGI_LABEL, `amagi/${type}`]
}

export type CreatePrOptions = {
  cwd: string
  branch: string
  base: string
  remote: string
  title: string
  body: string
  /** Labels applied to the PR; each is created on demand, best effort. */
  labels: readonly string[]
}

export type PrDriver = {
  createPr(opts: CreatePrOptions): Promise<PullRequest>
  /** Resolve the remote state of a PR, run from `cwd` so the forge CLI finds the repo. */
  getPr(cwd: string, number: number): Promise<PrState>
  /** Every open PR in the repo the `cwd` belongs to. */
  listOpenPrs(cwd: string): Promise<PrInfo[]>
  /** Whether an open PR can merge, normalized to mergeable/conflicted/unknown. */
  getMergeStatus(cwd: string, number: number): Promise<MergeStatus>
  /** The PR's full diff text, for explain responses. */
  getPrDiff(cwd: string, number: number): Promise<string>
  /** Every conversation comment, review summary, and inline review comment on a PR. */
  listComments(cwd: string, number: number): Promise<PrComment[]>
  /** Post a comment on the PR conversation. */
  postComment(cwd: string, number: number, body: string): Promise<void>
  /** Close a pull request, recording the operator's reason on the forge. */
  closePr(cwd: string, number: number, reason: string): Promise<void>
  /** Add a label to an existing pull request. */
  addLabel(cwd: string, number: number, label: string): Promise<void>
  /** Remove a label from an existing pull request. */
  removeLabel(cwd: string, number: number, label: string): Promise<void>
}

const GH_FIELDS =
  'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,updatedAt,labels'

/**
 * Github PRs through `gh`, with Chise's token and an Amagi-owned GH_CONFIG_DIR
 * so gh never touches the operator's auth state. Token-only: without
 * GH_TOKEN/GITHUB_TOKEN in the process environment gh fails closed.
 */
function githubPr(exec: Exec): PrDriver {
  let ownerRepo: string | null = null

  async function repoSlug(cwd: string): Promise<string> {
    if (ownerRepo === null) {
      ownerRepo = (
        await execOk(
          exec,
          ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
          { cwd, env: ghEnv() },
        )
      ).trim()
    }
    return ownerRepo
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      const token = forgeToken('github')
      await execOk(
        exec,
        ['git', ...(await gitTokenConfig(exec, cwd, remote, token)), 'push', '-u', remote, branch],
        { cwd },
      )
      for (const label of labels) {
        // --force makes create idempotent; failure (e.g. no write perms) is best effort
        await exec(['gh', 'label', 'create', label, '--force'], { cwd, env: ghEnv() })
      }
      const out = await execOk(
        exec,
        [
          'gh',
          'pr',
          'create',
          '--base',
          base,
          '--head',
          branch,
          '--title',
          title,
          '--body-file',
          '-',
          ...labels.flatMap((label) => ['--label', label]),
        ],
        { cwd, stdin: body, env: ghEnv() },
      )
      const url = out.trim()
      return { url, number: Number(url.split('/').pop() ?? 0) }
    },
    async getPr(cwd, number) {
      const out = await execOk(
        exec,
        ['gh', 'pr', 'view', String(number), '--json', 'state', '--jq', '.state'],
        { cwd, env: ghEnv() },
      )
      switch (out.trim().toUpperCase()) {
        case 'MERGED':
          return 'merged'
        case 'CLOSED':
          return 'closed'
        default:
          return 'open'
      }
    },
    async listOpenPrs(cwd) {
      const out = await execOk(exec, ['gh', 'pr', 'list', '--state', 'open', '--json', GH_FIELDS], {
        cwd,
        env: ghEnv(),
      })
      const raw = JSON.parse(out) as Array<
        Omit<PrInfo, 'labels'> & { labels?: Array<{ name?: string }> }
      >
      // gh reports labels as objects; the pass only needs the names.
      return raw.map((pr) => ({ ...pr, labels: (pr.labels ?? []).map((l) => l.name ?? '') }))
    },
    // GitHub computes mergeability asynchronously: bulk queries report UNKNOWN
    // until a single-PR query triggers it, so retry briefly until it resolves.
    async getMergeStatus(cwd, number) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const out = await execOk(
          exec,
          ['gh', 'pr', 'view', String(number), '--json', 'mergeable,mergeStateStatus'],
          { cwd, env: ghEnv() },
        )
        const status = JSON.parse(out) as { mergeable: string; mergeStateStatus: string }
        if (status.mergeable === 'CONFLICTING' || status.mergeStateStatus === 'DIRTY') {
          return 'conflicted'
        }
        if (status.mergeable === 'MERGEABLE' || status.mergeStateStatus === 'CLEAN') {
          return 'mergeable'
        }
        if (attempt < 4) await Bun.sleep(1000)
      }
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      return execOk(exec, ['gh', 'pr', 'diff', String(number)], { cwd, env: ghEnv() })
    },
    async listComments(cwd, number) {
      const slug = await repoSlug(cwd)
      const comments: PrComment[] = []
      for (const endpoint of [
        `repos/${slug}/issues/${number}/comments`,
        `repos/${slug}/pulls/${number}/reviews`,
        `repos/${slug}/pulls/${number}/comments`,
      ]) {
        const raw = await execOk(
          exec,
          [
            'gh',
            'api',
            endpoint,
            '--paginate',
            '--jq',
            '.[] | {id: (.id|tostring), user: .user.login, body}',
          ],
          { cwd, env: ghEnv() },
        )
        for (const line of raw.split('\n')) {
          if (line.trim() === '') continue
          comments.push(JSON.parse(line) as PrComment)
        }
      }
      return comments
    },
    async postComment(cwd, number, body) {
      await execOk(exec, ['gh', 'pr', 'comment', String(number), '--body-file', '-'], {
        cwd,
        stdin: body,
        env: ghEnv(),
      })
    },
    async closePr(cwd, number, reason) {
      await execOk(exec, ['gh', 'pr', 'close', String(number), '--comment', reason], {
        cwd,
        env: ghEnv(),
      })
    },
    async addLabel(cwd, number, label) {
      await execOk(exec, ['gh', 'pr', 'edit', String(number), '--add-label', label], {
        cwd,
        env: ghEnv(),
      })
    },
    async removeLabel(cwd, number, label) {
      await execOk(exec, ['gh', 'pr', 'edit', String(number), '--remove-label', label], {
        cwd,
        env: ghEnv(),
      })
    },
  }
}

type ForgejoRemote = { base: string; ownerRepo: string }

/**
 * Forgejo PRs through a direct token-authenticated API client. tea's `pulls
 * create` crashes on its own output in current releases, so the PR lifecycle
 * skips tea and talks to the Forgejo API with the token from the environment;
 * the ForgejoTracker still uses tea for issues.
 */
function forgejoPr(exec: Exec): PrDriver {
  let remote: ForgejoRemote | null = null

  async function forge(cwd: string): Promise<ForgejoRemote> {
    if (remote !== null) return remote
    const url = await execOk(exec, ['git', 'remote', 'get-url', 'origin'], { cwd })
    const parsed = parseRemote(url.trim())
    if (parsed === null) throw new Error(`cannot parse forge remote: ${url.trim()}`)
    remote = parsed
    return remote
  }

  async function forgeTokenOrThrow(): Promise<string> {
    const t = forgeToken('forgejo')
    if (t === null) {
      throw new Error('forgejo token missing: set FORGEJO_TOKEN in the amagi process environment')
    }
    return t
  }

  async function request(
    cwd: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const r = await forge(cwd)
    const res = await fetch(`${r.base}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `token ${await forgeTokenOrThrow()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      throw new Error(
        `forgejo api ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      )
    }
    return res
  }

  async function api(
    cwd: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await request(cwd, method, path, body)
    if (res.status === 204) return {}
    return (await res.json()) as Record<string, unknown>
  }

  /** Forgejo endpoints like the `.diff` suffix return text, not JSON. */
  async function rawApi(cwd: string, path: string): Promise<string> {
    const res = await request(cwd, 'GET', path)
    return await res.text()
  }

  const refName = (branch: unknown): string => {
    if (typeof branch !== 'object' || branch === null) return ''
    const ref = (branch as { ref?: unknown }).ref
    return typeof ref === 'string' ? ref : ''
  }

  const headOid = (branch: unknown): string | null => {
    if (typeof branch !== 'object' || branch === null) return null
    const sha = (branch as { sha?: unknown }).sha
    return typeof sha === 'string' ? sha : null
  }

  /** Maps Forgejo's bool mergeable + mergeable_state onto the shared shape. */
  function mergeFields(item: Record<string, unknown>): PrMergeStatus {
    const mergeable = item.mergeable
    const state = typeof item.mergeable_state === 'string' ? item.mergeable_state : ''
    if (mergeable === false || state === 'dirty') {
      return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
    }
    if (mergeable !== true || state === '' || state === 'unknown') {
      return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
    }
    return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
  }

  // The Forgejo issue-labels API keys on numeric label ids, so a name must be
  // resolved before a label can be added or removed.
  async function labelId(cwd: string, r: ForgejoRemote, name: string): Promise<number | null> {
    const raw = await api(cwd, 'GET', `repos/${r.ownerRepo}/labels`).catch(() => null)
    if (raw === null) return null
    const items = Array.isArray(raw) ? raw : []
    for (const item of items as Array<Record<string, unknown>>) {
      if (item.name === name && typeof item.id === 'number') return item.id
    }
    return null
  }

  return {
    async createPr({ cwd, branch, base, remote: remoteName, title, body, labels }) {
      const token = forgeToken('forgejo')
      await execOk(
        exec,
        [
          'git',
          ...(await gitTokenConfig(exec, cwd, remoteName, token)),
          'push',
          '-u',
          remoteName,
          branch,
        ],
        { cwd },
      )
      for (const label of labels) {
        // best effort: a label that exists or a run without write perms is not fatal
        await api(cwd, 'POST', `repos/${(await forge(cwd)).ownerRepo}/labels`, {
          name: label,
          color: 'A0A0A0',
        }).catch(() => {})
      }
      const created = await api(cwd, 'POST', `repos/${(await forge(cwd)).ownerRepo}/pulls`, {
        title,
        body,
        head: branch,
        base,
        labels,
      })
      const number = Number(created.index ?? created.number ?? 0)
      return {
        url:
          typeof created.html_url === 'string'
            ? created.html_url
            : `${(await forge(cwd)).base}/${(await forge(cwd)).ownerRepo}/pulls/${number}`,
        number,
      }
    },
    async getPr(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      if (pr.merged === true || pr.state === 'merged') return 'merged'
      if (pr.state === 'closed') return 'closed'
      return 'open'
    },
    async listOpenPrs(cwd) {
      const r = await forge(cwd)
      const raw = await api(cwd, 'GET', `repos/${r.ownerRepo}/pulls?state=open`)
      const items = Array.isArray(raw) ? raw : []
      return (items as Array<Record<string, unknown>>).map((item) => ({
        number: Number(item.number ?? 0),
        title: typeof item.title === 'string' ? item.title : '',
        body: typeof item.body === 'string' ? item.body : '',
        url: typeof item.html_url === 'string' ? item.html_url : '',
        headRefName: refName(item.head),
        baseRefName: refName(item.base),
        headRefOid: headOid(item.head),
        ...mergeFields(item),
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
        labels: ((item.labels as Array<{ name?: string }> | undefined) ?? []).map(
          (l) => l.name ?? '',
        ),
      }))
    },
    async getMergeStatus(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      if (pr.mergeable_state === 'has_conflicts') return 'conflicted'
      if (pr.mergeable === true) return 'mergeable'
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      const r = await forge(cwd)
      return rawApi(cwd, `repos/${r.ownerRepo}/pulls/${number}.diff`)
    },
    async listComments(cwd, number) {
      const r = await forge(cwd)
      const out: PrComment[] = []
      for (const path of [
        `repos/${r.ownerRepo}/issues/${number}/comments`,
        `repos/${r.ownerRepo}/pulls/${number}/reviews`,
        `repos/${r.ownerRepo}/pulls/${number}/comments`,
      ]) {
        const raw = await api(cwd, 'GET', path).catch(() => null)
        if (raw === null) continue
        const items = Array.isArray(raw) ? raw : []
        for (const item of items as Array<Record<string, unknown>>) {
          const user = item.user as { login?: string } | null | undefined
          if (typeof item.body !== 'string') continue
          out.push({
            id: String(item.id ?? ''),
            user: user?.login ?? '',
            body: item.body,
          })
        }
      }
      return out
    },
    async postComment(cwd, number, body) {
      await api(cwd, 'POST', `repos/${(await forge(cwd)).ownerRepo}/issues/${number}/comments`, {
        body,
      })
    },
    async closePr(cwd, number, _reason) {
      await api(cwd, 'PATCH', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`, {
        state: 'closed',
      })
    },
    async addLabel(cwd, number, label) {
      const r = await forge(cwd)
      // best effort: a label that exists or a run without write perms is not fatal
      await api(cwd, 'POST', `repos/${r.ownerRepo}/labels`, {
        name: label,
        color: 'A0A0A0',
      }).catch(() => {})
      const id = await labelId(cwd, r, label)
      if (id === null) return
      await api(cwd, 'POST', `repos/${r.ownerRepo}/issues/${number}/labels`, { labels: [id] })
    },
    async removeLabel(cwd, number, label) {
      const r = await forge(cwd)
      const id = await labelId(cwd, r, label)
      if (id === null) return
      await api(cwd, 'DELETE', `repos/${r.ownerRepo}/issues/${number}/labels/${id}`)
    },
  }
}

export function makePrDriver(kind: string, exec: Exec = defaultExec): PrDriver {
  switch (kind) {
    case 'github':
      return githubPr(exec)
    case 'forgejo':
      return forgejoPr(exec)
    default:
      throw new NotImplementedDriverError('forge', kind)
  }
}
