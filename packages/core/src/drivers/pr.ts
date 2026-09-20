import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'

export type PullRequest = { url: string; number: number }

/** Remote lifecycle of a pull request, for reconciling parked tasks. */
export type PrState = 'open' | 'closed' | 'merged'

/** A PR conversation comment, review summary, or inline review comment. */
export type PrComment = { id: string; user: string; body: string }

export type CreatePrOptions = {
  cwd: string
  branch: string
  base: string
  remote: string
  title: string
  body: string
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
 * Rewrites the ssh remote to https carrying the token, so an unattended run
 * never blocks on an ssh passphrase prompt. Empty without a token, meaning
 * git keeps using the configured ssh remote.
 */
export function gitTokenConfig(): string[] {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (!token) return []
  return ['-c', `url.https://x-access-token:${token}@github.com/.insteadOf=git@github.com:`]
}

function githubPr(exec: Exec): PrDriver {
  let ownerRepo: string | null = null

  async function repoSlug(cwd: string): Promise<string> {
    if (ownerRepo === null) {
      ownerRepo = (
        await execOk(
          exec,
          ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
          { cwd },
        )
      ).trim()
    }
    return ownerRepo
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body }) {
      await execOk(exec, ['git', ...gitTokenConfig(), 'push', '-u', remote, branch], { cwd })
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
        ],
        { cwd, stdin: body },
      )
      const url = out.trim()
      return { url, number: Number(url.split('/').pop() ?? 0) }
    },
    async getPr(cwd, number) {
      const out = await execOk(
        exec,
        ['gh', 'pr', 'view', String(number), '--json', 'state', '--jq', '.state'],
        { cwd },
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
          { cwd },
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
      })
    },
  }
}

export function makePrDriver(kind: string, exec: Exec = defaultExec): PrDriver {
  switch (kind) {
    case 'github':
      return githubPr(exec)
    default:
      throw new NotImplementedDriverError('forge', kind)
  }
}
