import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'

export type PullRequest = { url: string; number: number }

/** Remote lifecycle of a pull request, for reconciling parked tasks. */
export type PrState = 'open' | 'closed' | 'merged'

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
  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      await execOk(exec, ['git', ...gitTokenConfig(), 'push', '-u', remote, branch], { cwd })
      for (const label of labels) {
        // --force makes create idempotent; failure (e.g. no write perms) is best effort
        await exec(['gh', 'label', 'create', label, '--force'], { cwd })
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
