import type { MergeStatus } from '../events.ts'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'
import { forgeToken, ghEnv, gitTokenConfig, parseRemote } from './forge-cred.ts'

export type PullRequest = { url: string; number: number }

/**
 * One open PR, with its merge status normalized across forges plus the forge's
 * own mergeability flags. `mergeable`/`mergeStateStatus` use gh's wording on
 * both drivers so consumers filter one way regardless of forge.
 */
export type OpenPr = {
  number: number
  title: string
  url: string
  headRefName: string
  baseRefName: string
  mergeStatus: MergeStatus
  mergeable: string
  mergeStateStatus: string
}

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
  /** Whether an open PR can merge, normalized to mergeable/conflicted/unknown. */
  getMergeStatus(cwd: string, number: number): Promise<MergeStatus>
  /** Every open PR in the repo, with a per-PR normalized merge status. */
  listOpenPrs(cwd: string): Promise<OpenPr[]>
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

  function ghMergeStatus(mergeable: string, mergeStateStatus: string): MergeStatus {
    if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return 'conflicted'
    if (mergeable === 'MERGEABLE' || mergeStateStatus === 'CLEAN') return 'mergeable'
    return 'unknown'
  }

  // GitHub computes mergeability asynchronously, so a fresh PR may report
  // UNKNOWN until a single-PR query has forced the check.
  async function ghMergeStatusResolved(cwd: string, number: number): Promise<MergeStatus> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const out = await execOk(
        exec,
        ['gh', 'pr', 'view', String(number), '--json', 'mergeable,mergeStateStatus'],
        { cwd, env: ghEnv() },
      )
      const status = JSON.parse(out) as { mergeable: string; mergeStateStatus: string }
      const resolved = ghMergeStatus(status.mergeable, status.mergeStateStatus)
      if (resolved !== 'unknown') return resolved
      if (attempt < 4) await Bun.sleep(1000)
    }
    return 'unknown'
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
    async getMergeStatus(cwd, number) {
      return ghMergeStatusResolved(cwd, number)
    },
    async listOpenPrs(cwd) {
      const out = await execOk(
        exec,
        [
          'gh',
          'pr',
          'list',
          '--state',
          'open',
          '--json',
          'number,title,url,headRefName,baseRefName,mergeable,mergeStateStatus',
        ],
        { cwd, env: ghEnv() },
      )
      const raw = JSON.parse(out) as Array<{
        number: number
        title: string
        url: string
        headRefName: string
        baseRefName: string
        mergeable: string
        mergeStateStatus: string
      }>
      return Promise.all(
        raw.map(async (p) => {
          // gh pr list reports UNKNOWN until mergeability has been computed,
          // so a single-PR query forces the check for those.
          const status = ghMergeStatus(p.mergeable, p.mergeStateStatus)
          return {
            number: p.number,
            title: p.title,
            url: p.url,
            headRefName: p.headRefName,
            baseRefName: p.baseRefName,
            mergeStatus: status === 'unknown' ? await ghMergeStatusResolved(cwd, p.number) : status,
            mergeable: p.mergeable,
            mergeStateStatus: p.mergeStateStatus,
          }
        }),
      )
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

  async function api(cwd: string, method: string, path: string, body?: unknown) {
    const r = await forge(cwd)
    const token = forgeToken('forgejo')
    if (token === null) {
      throw new Error('forgejo token missing: set FORGEJO_TOKEN in the amagi process environment')
    }
    const res = await fetch(`${r.base}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `token ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      throw new Error(
        `forgejo api ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      )
    }
    if (res.status === 204) return {}
    return (await res.json()) as Record<string, unknown>
  }

  function fjMergeStatus(pr: Record<string, unknown>): MergeStatus {
    if (pr.mergeable_state === 'has_conflicts') return 'conflicted'
    if (pr.mergeable === true) return 'mergeable'
    return 'unknown'
  }

  async function fjMergeStatusResolved(cwd: string, number: number): Promise<MergeStatus> {
    const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
    return fjMergeStatus(pr)
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
    async getMergeStatus(cwd, number) {
      return fjMergeStatusResolved(cwd, number)
    },
    async listOpenPrs(cwd) {
      const r = await forge(cwd)
      const raw = await api(cwd, 'GET', `repos/${r.ownerRepo}/pulls?state=open`)
      const items = Array.isArray(raw) ? raw : []
      return Promise.all(
        (items as Array<Record<string, unknown>>).map(async (p) => {
          const head = p.head as { ref?: string } | null | undefined
          const base = p.base as { ref?: string } | null | undefined
          const number = Number(p.number ?? p.index ?? 0)
          const status = fjMergeStatus(p)
          return {
            number,
            title: String(p.title ?? ''),
            url:
              typeof p.html_url === 'string'
                ? p.html_url
                : `${r.base}/${r.ownerRepo}/pulls/${number}`,
            headRefName: head?.ref ?? '',
            baseRefName: base?.ref ?? '',
            mergeStatus: status === 'unknown' ? await fjMergeStatusResolved(cwd, number) : status,
            // The forgejo state names map onto gh's so one filter works for both.
            mergeable:
              p.mergeable_state === 'has_conflicts'
                ? 'CONFLICTING'
                : p.mergeable === true
                  ? 'MERGEABLE'
                  : 'UNKNOWN',
            mergeStateStatus:
              p.mergeable_state === 'clean'
                ? 'CLEAN'
                : p.mergeable_state === 'has_conflicts'
                  ? 'DIRTY'
                  : 'UNKNOWN',
          }
        }),
      )
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
