import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'
import { forgeToken, ghEnv, gitTokenConfig, parseRemote } from './forge-cred.ts'

export type PullRequest = { url: string; number: number }

/** Remote lifecycle of a pull request, for reconciling parked tasks. */
export type PrState = 'open' | 'closed' | 'merged'

/** A PR conversation comment, review summary, or inline review comment. */
export type PrComment = { id: string; user: string; body: string }

/** Marks a PR as agent-generated, so humans can tell it from their own. */
export const AMAGI_LABEL = 'amagi'

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
  /** Every conversation comment, review summary, and inline review comment on a PR. */
  listComments(cwd: string, number: number): Promise<PrComment[]>
  /** Post a comment on the PR conversation. */
  postComment(cwd: string, number: number, body: string): Promise<void>
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
