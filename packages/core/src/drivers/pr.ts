import { basename } from 'node:path'
import type { Config } from '../config.ts'
import type { MergeStatus } from '../events.ts'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'
import { mergeTreeVerdict, type PrInfo, type PrMergeStatus } from '../pr-check.ts'
import {
  ForgeApiError,
  type ForgeEndpoint,
  forgeFetch,
  forgeJson,
  forgePages,
  resolveForge,
} from './forge-api.ts'
import { forgeToken, gitTokenConfig } from './forge-cred.ts'
import { assertSafePushDestination } from './push-safety.ts'

export type PullRequest = { url: string; number: number }

/** Remote lifecycle of a pull request, for reconciling parked tasks. */
export type PrState = 'open' | 'closed' | 'merged'

/** A PR conversation comment, review summary, or inline review comment. */
export type PrComment = { id: string; user: string; body: string }

/** What a PR changes, read from the forge so no checkout is needed. */
export type PrChanges = {
  baseSha: string | null
  headSha: string | null
  /** The first page of changed paths only (about 100); `fileCount` is the full count. */
  changedFiles: string[]
  fileCount: number
}

/** Marks a PR as agent-generated, so humans can tell it from their own. */
export const AMAGI_LABEL = 'amagi'

/**
 * Marks an agent PR as pointless (empty diff against base). Owned by the
 * watcher in both directions: added when the PR qualifies, removed when it
 * stops, so a human closing the PR is the only terminal step.
 */
export const NEEDS_CLOSING_LABEL = 'amagi/needs-closing'

/** On a PR closed unmerged: the task is finished anyway, as if the PR had merged. */
export const DONE_LABEL = 'amagi/done'
/** On a PR closed unmerged: the work was wrong, so the task starts a fresh attempt. */
export const REWORK_LABEL = 'amagi/rework'
/**
 * Created alongside every agent PR but never attached by amagi, so a human
 * closing a PR finds them in the forge's label picker.
 */
export const OUTCOME_LABELS = [DONE_LABEL, REWORK_LABEL] as const

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
  /** Names of the labels on a PR in any state. */
  getPrLabels(cwd: string, number: number): Promise<string[]>
  /** Every open PR in the repo the `cwd` belongs to. */
  listOpenPrs(cwd: string): Promise<PrInfo[]>
  /** Whether an open PR can merge, normalized to mergeable/conflicted/unknown. */
  getMergeStatus(cwd: string, number: number): Promise<MergeStatus>
  /** The PR's full diff text, for explain responses. */
  getPrDiff(cwd: string, number: number): Promise<string>
  /** Base and head shas plus changed file paths, for routing a mention without a checkout. */
  getPrChanges(cwd: string, number: number): Promise<PrChanges>
  /** Every conversation comment, review summary, and inline review comment on a PR. */
  listComments(cwd: string, number: number): Promise<PrComment[]>
  /** Post a comment on the PR conversation. */
  postComment(cwd: string, number: number, body: string): Promise<void>
  /** The PR description as the forge stores it. */
  getPrBody(cwd: string, number: number): Promise<string>
  /** Replace the PR title and description. */
  updatePr(cwd: string, number: number, update: { title: string; body: string }): Promise<void>
  /** Close a pull request, recording the operator's reason on the forge. */
  closePr(cwd: string, number: number, reason: string): Promise<void>
  /** Add a label to an existing pull request. */
  addLabel(cwd: string, number: number, label: string): Promise<void>
  /** Remove a label from an existing pull request. */
  removeLabel(cwd: string, number: number, label: string): Promise<void>
  /** Delete a branch on the remote; a branch already gone is not an error. */
  deleteBranch(cwd: string, remote: string, branch: string): Promise<void>
  /**
   * Upload a file to the repository before any PR exists and return a URL a
   * PR description can link. Absent on forges without such an API.
   */
  uploadFile?: ((cwd: string, path: string) => Promise<string>) | undefined
}

/**
 * Pushes the task branch. Branch names derive from the task, so a requeued
 * task (say, its PR merged and then reverted) collides with the branch its
 * earlier attempt left on the remote; that copy is overwritten, pinned to the
 * sha just observed. A branch still backing an open PR is never overwritten.
 */
async function pushTaskBranch(
  exec: Exec,
  opts: Pick<CreatePrOptions, 'cwd' | 'remote' | 'branch'>,
  kind: Config['forge']['kind'],
  openPrOn: (branch: string) => Promise<{ number: number; url: string } | null>,
): Promise<void> {
  const { cwd, remote, branch } = opts
  const auth = await gitTokenConfig(exec, cwd, remote, forgeToken(kind, cwd), kind)
  const ref = `refs/heads/${branch}`
  const heads = await execOk(exec, ['git', 'ls-remote', '--heads', remote, ref], {
    cwd,
    env: auth,
  })
  const remoteSha =
    heads
      .split('\n')
      .map((line) => line.split('\t'))
      .find(([, name]) => name === ref)?.[0] ?? ''
  if (remoteSha !== '') {
    const open = await openPrOn(branch)
    if (open !== null) {
      throw new Error(
        `${branch} already backs open pull request #${open.number} (${open.url}); refusing to overwrite it`,
      )
    }
  }
  // An empty expected sha makes the lease demand that the branch is still absent.
  await assertSafePushDestination(exec, cwd, remote, branch, auth)
  await execOk(
    exec,
    ['git', 'push', '-u', `--force-with-lease=${ref}:${remoteSha}`, remote, branch],
    { cwd, env: auth },
  )
}

async function deleteRemoteBranch(
  exec: Exec,
  cwd: string,
  remote: string,
  branch: string,
  kind: Config['forge']['kind'],
): Promise<void> {
  const auth = await gitTokenConfig(exec, cwd, remote, forgeToken(kind, cwd), kind)
  await assertSafePushDestination(exec, cwd, remote, branch, auth)
  const r = await exec(['git', 'push', remote, '--delete', branch], {
    cwd,
    env: auth,
  })
  if (r.exitCode !== 0 && !/remote ref does not exist/i.test(r.stderr)) {
    throw new Error(`deleting remote branch ${branch}: ${r.stderr.trim()}`)
  }
}

/**
 * GitHub PRs over the REST API. The repository is the owner/repo path of the
 * forge remote; a missing token fails the first call, naming GH_TOKEN.
 */
function githubPr(exec: Exec, forgeRemote: string): PrDriver {
  let endpoint: ForgeEndpoint | null = null

  async function forge(cwd: string): Promise<ForgeEndpoint> {
    endpoint ??= await resolveForge('github', cwd, forgeRemote, exec)
    return endpoint
  }

  async function repoPath(cwd: string, rest: string): Promise<string> {
    return `repos/${(await forge(cwd)).ownerRepo}/${rest}`
  }

  async function api(cwd: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return forgeJson(await forge(cwd), method, path, body)
  }

  async function pages(cwd: string, path: string): Promise<Array<Record<string, unknown>>> {
    return forgePages(await forge(cwd), path)
  }

  async function pull(cwd: string, number: number): Promise<Record<string, unknown>> {
    const raw = await api(cwd, 'GET', await repoPath(cwd, `pulls/${number}`))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  }

  async function comment(cwd: string, number: number, body: string): Promise<void> {
    await api(cwd, 'POST', await repoPath(cwd, `issues/${number}/comments`), { body })
  }

  const text = (value: unknown): string => (typeof value === 'string' ? value : '')

  /** A `ref` or `sha` of the `head` or `base` branch of a pull request, null when absent. */
  function refField(
    item: Record<string, unknown>,
    side: 'head' | 'base',
    field: 'ref' | 'sha',
  ): string | null {
    const value = (item[side] as Record<string, unknown> | null | undefined)?.[field]
    return typeof value === 'string' ? value : null
  }

  /**
   * Maps GitHub's `mergeable` and `mergeable_state` onto the shared shape. Both
   * stay null or unknown while GitHub is still computing them.
   */
  function mergeFields(item: Record<string, unknown>): PrMergeStatus {
    const mergeable =
      item.mergeable === true ? 'MERGEABLE' : item.mergeable === false ? 'CONFLICTING' : 'UNKNOWN'
    const state =
      typeof item.mergeable_state === 'string' ? item.mergeable_state.toUpperCase() : 'UNKNOWN'
    return { mergeable, mergeStateStatus: state }
  }

  function toPrInfo(item: Record<string, unknown>): PrInfo {
    return {
      number: Number(item.number ?? 0),
      title: text(item.title),
      body: text(item.body),
      url: text(item.html_url),
      headRefName: refField(item, 'head', 'ref') ?? '',
      baseRefName: refField(item, 'base', 'ref') ?? '',
      headRefOid: refField(item, 'head', 'sha'),
      ...mergeFields(item),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      labels: ((item.labels as Array<{ name?: string }> | undefined) ?? []).map(
        (l) => l.name ?? '',
      ),
    }
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      const { ownerRepo } = await forge(cwd)
      const [owner] = ownerRepo.split('/')
      await pushTaskBranch(exec, { cwd, remote, branch }, 'github', async (head) => {
        const open = (
          await pages(
            cwd,
            `repos/${ownerRepo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
          )
        )[0]
        return open === undefined ? null : { number: Number(open.number), url: text(open.html_url) }
      })
      for (const label of [...labels, ...OUTCOME_LABELS]) {
        // best effort: a label that exists (422) or a run without write perms is not fatal
        await api(cwd, 'POST', await repoPath(cwd, 'labels'), {
          name: label,
          color: 'A0A0A0',
        }).catch(() => {})
      }
      const created = (await api(cwd, 'POST', await repoPath(cwd, 'pulls'), {
        title,
        body,
        head: branch,
        base,
      })) as Record<string, unknown>
      const number = Number(created.number ?? 0)
      // The pulls create endpoint takes no labels; the issue labels endpoint attaches them.
      await api(cwd, 'POST', await repoPath(cwd, `issues/${number}/labels`), { labels })
      return { url: text(created.html_url), number }
    },
    async getPr(cwd, number) {
      const pr = await pull(cwd, number)
      if (pr.merged === true) return 'merged'
      return pr.state === 'closed' ? 'closed' : 'open'
    },
    async getPrLabels(cwd, number) {
      const labels = (await pull(cwd, number)).labels as Array<{ name?: string }> | undefined
      return (labels ?? []).map((l) => l.name ?? '')
    },
    async listOpenPrs(cwd) {
      const listed = await pages(cwd, await repoPath(cwd, 'pulls?state=open'))
      // The list omits mergeability, which only the single-PR answer carries. Read one
      // at a time: bursts of concurrent requests trip GitHub's secondary rate limit.
      const prs: PrInfo[] = []
      for (const pr of listed) prs.push(toPrInfo(await pull(cwd, Number(pr.number))))
      return prs
    },
    // GitHub computes mergeability on first read: the answer stays unknown for a
    // moment, so retry briefly until it resolves.
    async getMergeStatus(cwd, number) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const { mergeable, mergeStateStatus } = mergeFields(await pull(cwd, number))
        if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return 'conflicted'
        if (mergeable === 'MERGEABLE' || mergeStateStatus === 'CLEAN') return 'mergeable'
        if (attempt < 4) await Bun.sleep(1000)
      }
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      const res = await forgeFetch(
        await forge(cwd),
        'GET',
        await repoPath(cwd, `pulls/${number}`),
        undefined,
        { accept: 'application/vnd.github.diff' },
      )
      return res.text()
    },
    async getPrChanges(cwd, number) {
      const r = await forge(cwd)
      const [item, res] = await Promise.all([
        pull(cwd, number),
        forgeFetch(r, 'GET', `repos/${r.ownerRepo}/pulls/${number}/files?per_page=100`),
      ])
      const changedFiles = ((await res.json()) as Array<Record<string, unknown>>).flatMap((f) =>
        typeof f.filename === 'string' ? [f.filename] : [],
      )
      return {
        baseSha: refField(item, 'base', 'sha'),
        headSha: refField(item, 'head', 'sha'),
        changedFiles,
        fileCount:
          typeof item.changed_files === 'number' ? item.changed_files : changedFiles.length,
      }
    },
    async listComments(cwd, number) {
      const r = await forge(cwd)
      const comments: PrComment[] = []
      for (const rest of [
        `issues/${number}/comments`,
        `pulls/${number}/reviews`,
        `pulls/${number}/comments`,
      ]) {
        for (const item of await pages(cwd, `repos/${r.ownerRepo}/${rest}`)) {
          const user = item.user as { login?: string } | null | undefined
          if (typeof item.body !== 'string') continue
          comments.push({ id: String(item.id ?? ''), user: user?.login ?? '', body: item.body })
        }
      }
      return comments
    },
    postComment: comment,
    async getPrBody(cwd, number) {
      return text((await pull(cwd, number)).body)
    },
    async updatePr(cwd, number, { title, body }) {
      await api(cwd, 'PATCH', await repoPath(cwd, `pulls/${number}`), { title, body })
    },
    async closePr(cwd, number, reason) {
      await comment(cwd, number, reason)
      await api(cwd, 'PATCH', await repoPath(cwd, `pulls/${number}`), { state: 'closed' })
    },
    // The issues endpoint creates a label that does not exist yet.
    async addLabel(cwd, number, label) {
      await api(cwd, 'POST', await repoPath(cwd, `issues/${number}/labels`), { labels: [label] })
    },
    async removeLabel(cwd, number, label) {
      // A label already gone from the PR is not an error.
      await forgeFetch(
        await forge(cwd),
        'DELETE',
        await repoPath(cwd, `issues/${number}/labels/${encodeURIComponent(label)}`),
      ).catch(missingOk)
    },
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, 'github')
    },
  }
}

const items = (raw: unknown): Array<Record<string, unknown>> =>
  Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []

const missingOk = (err: unknown): [] => {
  if (err instanceof ForgeApiError && err.status === 404) return []
  throw err
}

/** Forgejo PRs over the REST API. The repository is the owner/repo path of the forge remote. */
function forgejoPr(exec: Exec, forgeRemote: string): PrDriver {
  let endpoint: ForgeEndpoint | null = null

  async function forge(cwd: string): Promise<ForgeEndpoint> {
    endpoint ??= await resolveForge('forgejo', cwd, forgeRemote, exec)
    return endpoint
  }

  async function api(
    cwd: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    return ((await forgeJson(await forge(cwd), method, path, body)) ?? {}) as Record<
      string,
      unknown
    >
  }

  async function pages(cwd: string, path: string): Promise<Array<Record<string, unknown>>> {
    return forgePages(await forge(cwd), path)
  }

  /** Forgejo endpoints like the `.diff` suffix return text, not JSON. */
  async function rawApi(cwd: string, path: string): Promise<string> {
    return (await forgeFetch(await forge(cwd), 'GET', path)).text()
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

  /**
   * Maps Forgejo's bool `mergeable` onto the shared shape. Forgejo also answers
   * false while it is still checking, after a failed check and for every draft,
   * so false counts as a conflict only on a non-draft PR whose head and base a
   * local merge-tree finds conflicting; otherwise it is unknown.
   */
  async function mergeFields(cwd: string, item: Record<string, unknown>): Promise<PrMergeStatus> {
    if (item.mergeable === true) return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
    const unknown = { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
    const head = headOid(item.head)
    const base = headOid(item.base)
    if (item.mergeable !== false || item.draft === true || head === null || base === null) {
      return unknown
    }
    // A sha not fetched locally makes merge-tree fail: no verdict, not a conflict.
    const verdict = await mergeTreeVerdict({ repoRoot: cwd, base, head, exec }).catch(() => null)
    return verdict === 'conflict'
      ? { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
      : unknown
  }

  /**
   * Fetches the base branch of every PR mergeFields will run merge-tree on
   * whose base commit is not local yet, so a base moved on the forge still
   * gets a verdict. Best effort: a failed fetch leaves the PR unknown.
   */
  async function fetchBases(cwd: string, prs: Array<Record<string, unknown>>): Promise<void> {
    const missing = new Set<string>()
    for (const pr of prs) {
      const sha = headOid(pr.base)
      const ref = refName(pr.base)
      if (pr.mergeable !== false || pr.draft === true || sha === null || ref === '') continue
      const has = await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd })
      if (has.exitCode !== 0) missing.add(ref)
    }
    if (missing.size === 0) return
    const auth = await gitTokenConfig(exec, cwd, forgeRemote, forgeToken('forgejo', cwd), 'forgejo')
    await exec(
      ['git', 'fetch', '--no-tags', forgeRemote, ...[...missing].map((ref) => `refs/heads/${ref}`)],
      { cwd, env: auth },
    )
  }

  async function listOpenPrs(cwd: string): Promise<PrInfo[]> {
    const r = await forge(cwd)
    const raw = await pages(cwd, `repos/${r.ownerRepo}/pulls?state=open`)
    await fetchBases(cwd, raw)
    return Promise.all(
      raw.map(async (item) => ({
        number: Number(item.number ?? 0),
        title: typeof item.title === 'string' ? item.title : '',
        body: typeof item.body === 'string' ? item.body : '',
        url: typeof item.html_url === 'string' ? item.html_url : '',
        headRefName: refName(item.head),
        baseRefName: refName(item.base),
        headRefOid: headOid(item.head),
        ...(await mergeFields(cwd, item)),
        createdAt: typeof item.created_at === 'string' ? item.created_at : '',
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
        labels: ((item.labels as Array<{ name?: string }> | undefined) ?? []).map(
          (l) => l.name ?? '',
        ),
      })),
    )
  }

  // The Forgejo issue-labels API keys on numeric label ids, so a name must be
  // resolved before a label can be added or removed.
  async function labelId(cwd: string, r: ForgeEndpoint, name: string): Promise<number | null> {
    for (const item of await pages(cwd, `repos/${r.ownerRepo}/labels`)) {
      if (item.name === name && typeof item.id === 'number') return item.id
    }
    return null
  }

  return {
    async createPr({ cwd, branch, base, remote: remoteName, title, body, labels }) {
      const r = await forge(cwd)
      await pushTaskBranch(
        exec,
        { cwd, remote: remoteName, branch },
        'forgejo',
        async (head) => (await listOpenPrs(cwd)).find((pr) => pr.headRefName === head) ?? null,
      )
      for (const label of [...labels, ...OUTCOME_LABELS]) {
        // best effort: a label that exists or a run without write perms is not fatal
        await api(cwd, 'POST', `repos/${(await forge(cwd)).ownerRepo}/labels`, {
          name: label,
          color: 'A0A0A0',
        }).catch(() => {})
      }
      // The create endpoint takes label ids, not names. A label still missing after its
      // best-effort create is skipped.
      const labelIds: number[] = []
      for (const label of labels) {
        const id = await labelId(cwd, r, label)
        if (id !== null) labelIds.push(id)
      }
      const created = await api(cwd, 'POST', `repos/${r.ownerRepo}/pulls`, {
        head: branch,
        base,
        title,
        body,
        labels: labelIds,
      })
      return { url: String(created.html_url ?? ''), number: Number(created.number ?? 0) }
    },
    async getPr(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      if (pr.merged === true || pr.state === 'merged') return 'merged'
      if (pr.state === 'closed') return 'closed'
      return 'open'
    },
    async getPrLabels(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      return ((pr.labels as Array<{ name?: string }> | undefined) ?? []).map((l) => l.name ?? '')
    },
    listOpenPrs,
    async getMergeStatus(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      await fetchBases(cwd, [pr])
      const { mergeable } = await mergeFields(cwd, pr)
      if (mergeable === 'CONFLICTING') return 'conflicted'
      if (mergeable === 'MERGEABLE') return 'mergeable'
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      const r = await forge(cwd)
      return rawApi(cwd, `repos/${r.ownerRepo}/pulls/${number}.diff`)
    },
    async getPrChanges(cwd, number) {
      const r = await forge(cwd)
      const pr = `repos/${r.ownerRepo}/pulls/${number}`
      const [item, res] = await Promise.all([
        api(cwd, 'GET', pr),
        forgeFetch(r, 'GET', `${pr}/files?limit=100`),
      ])
      const changedFiles = items(await res.json()).flatMap((f) =>
        typeof f.filename === 'string' ? [f.filename] : [],
      )
      const total = Number(res.headers.get('x-total-count'))
      return {
        baseSha: headOid(item.base),
        headSha: headOid(item.head),
        changedFiles,
        fileCount: total > 0 ? total : changedFiles.length,
      }
    },
    async listComments(cwd, number) {
      const r = await forge(cwd)
      const pr = `repos/${r.ownerRepo}/pulls/${number}`
      // The issue and review-comment endpoints take no page parameters and return everything.
      const conversation = items(
        await api(cwd, 'GET', `repos/${r.ownerRepo}/issues/${number}/comments`).catch(missingOk),
      )
      const reviews = await pages(cwd, `${pr}/reviews`).catch(missingOk)
      const inline: Array<Record<string, unknown>> = []
      for (const review of reviews) {
        if (typeof review.id !== 'number' || review.comments_count === 0) continue
        inline.push(
          ...items(await api(cwd, 'GET', `${pr}/reviews/${review.id}/comments`).catch(missingOk)),
        )
      }
      const out: PrComment[] = []
      for (const item of [...conversation, ...reviews, ...inline]) {
        const user = item.user as { login?: string } | null | undefined
        if (typeof item.body !== 'string') continue
        out.push({
          id: String(item.id ?? ''),
          user: user?.login ?? '',
          body: item.body,
        })
      }
      return out
    },
    async postComment(cwd, number, body) {
      const r = await forge(cwd)
      await api(cwd, 'POST', `repos/${r.ownerRepo}/issues/${number}/comments`, { body })
    },
    async getPrBody(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      return typeof pr.body === 'string' ? pr.body : ''
    },
    async updatePr(cwd, number, { title, body }) {
      const r = await forge(cwd)
      await api(cwd, 'PATCH', `repos/${r.ownerRepo}/pulls/${number}`, { title, body })
    },
    async closePr(cwd, number, reason) {
      const r = await forge(cwd)
      await api(cwd, 'POST', `repos/${r.ownerRepo}/issues/${number}/comments`, { body: reason })
      await api(cwd, 'PATCH', `repos/${r.ownerRepo}/pulls/${number}`, { state: 'closed' })
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
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, 'forgejo')
    },
  }
}

/**
 * GitLab merge requests over the REST API. The project is the URL-encoded
 * owner/repo path of the forge remote, standing in for a numeric id.
 */
function gitlabPr(exec: Exec, forgeRemote: string): PrDriver {
  let endpoint: ForgeEndpoint | null = null

  async function forge(cwd: string): Promise<ForgeEndpoint> {
    endpoint ??= await resolveForge('gitlab', cwd, forgeRemote, exec)
    return endpoint
  }

  async function projectPath(cwd: string, rest: string): Promise<string> {
    return `projects/${encodeURIComponent((await forge(cwd)).ownerRepo)}/${rest}`
  }

  async function api(cwd: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return forgeJson(await forge(cwd), method, path, body)
  }

  async function pages(cwd: string, path: string): Promise<Array<Record<string, unknown>>> {
    return forgePages(await forge(cwd), path)
  }

  async function mr(cwd: string, number: number): Promise<Record<string, unknown>> {
    const raw = await api(cwd, 'GET', await projectPath(cwd, `merge_requests/${number}`))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  }

  const text = (value: unknown): string => (typeof value === 'string' ? value : '')

  /** Maps GitLab's conflict and mergeability fields onto the shared shape. */
  function mergeFields(item: Record<string, unknown>): PrMergeStatus {
    if (item.has_conflicts === true || item.detailed_merge_status === 'conflict') {
      return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
    }
    if (item.detailed_merge_status === 'mergeable' || item.merge_status === 'can_be_merged') {
      return { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }
    }
    return { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }
  }

  function toPrInfo(item: Record<string, unknown>): PrInfo {
    return {
      number: Number(item.iid ?? 0),
      title: text(item.title),
      body: text(item.description),
      url: text(item.web_url),
      headRefName: text(item.source_branch),
      baseRefName: text(item.target_branch),
      headRefOid: typeof item.sha === 'string' ? item.sha : null,
      ...mergeFields(item),
      createdAt: text(item.created_at),
      updatedAt: text(item.updated_at),
      labels: Array.isArray(item.labels) ? item.labels.map(text) : [],
    }
  }

  async function openMrs(cwd: string, sourceBranch?: string): Promise<PrInfo[]> {
    const filter =
      sourceBranch === undefined ? '' : `&source_branch=${encodeURIComponent(sourceBranch)}`
    const path = `merge_requests?state=opened&with_merge_status_recheck=true${filter}`
    return (await pages(cwd, await projectPath(cwd, path))).map(toPrInfo)
  }

  async function postComment(cwd: string, number: number, body: string): Promise<void> {
    await api(cwd, 'POST', await projectPath(cwd, `merge_requests/${number}/notes`), { body })
  }

  async function update(
    cwd: string,
    number: number,
    fields: Record<string, string>,
  ): Promise<void> {
    await api(cwd, 'PUT', await projectPath(cwd, `merge_requests/${number}`), fields)
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      await pushTaskBranch(
        exec,
        { cwd, remote, branch },
        'gitlab',
        async (head) => (await openMrs(cwd, head))[0] ?? null,
      )
      // best effort: an existing label answers 409, and a token without label rights is not fatal
      for (const label of OUTCOME_LABELS) {
        await api(cwd, 'POST', await projectPath(cwd, 'labels'), {
          name: label,
          color: '#A0A0A0',
        }).catch(() => {})
      }
      // GitLab attaches the labels on create; the answer carries the new MR's iid and web_url.
      const created = (await api(cwd, 'POST', await projectPath(cwd, 'merge_requests'), {
        source_branch: branch,
        target_branch: base,
        title,
        description: body,
        labels: labels.join(','),
      })) as Record<string, unknown>
      return { url: text(created.web_url), number: Number(created.iid ?? 0) }
    },
    async getPr(cwd, number) {
      const state = (await mr(cwd, number)).state
      if (state === 'merged') return 'merged'
      if (state === 'closed' || state === 'locked') return 'closed'
      return 'open'
    },
    async getPrLabels(cwd, number) {
      const labels = (await mr(cwd, number)).labels
      return Array.isArray(labels) ? labels.map(text) : []
    },
    listOpenPrs: (cwd) => openMrs(cwd),
    async getMergeStatus(cwd, number) {
      const { mergeable } = mergeFields(await mr(cwd, number))
      if (mergeable === 'CONFLICTING') return 'conflicted'
      if (mergeable === 'MERGEABLE') return 'mergeable'
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      const path = await projectPath(cwd, `merge_requests/${number}/raw_diffs`)
      return (await forgeFetch(await forge(cwd), 'GET', path)).text()
    },
    async getPrChanges(cwd, number) {
      const [item, diffs] = await Promise.all([
        mr(cwd, number),
        api(cwd, 'GET', await projectPath(cwd, `merge_requests/${number}/diffs?per_page=100`)),
      ])
      const refs =
        typeof item.diff_refs === 'object' && item.diff_refs !== null
          ? (item.diff_refs as Record<string, unknown>)
          : {}
      const changedFiles = (
        Array.isArray(diffs) ? (diffs as Array<Record<string, unknown>>) : []
      ).flatMap((d) => (typeof d.new_path === 'string' ? [d.new_path] : []))
      // changes_count is a string, "1000+" once GitLab stops counting.
      const total = Number.parseInt(text(item.changes_count), 10)
      return {
        baseSha: typeof refs.base_sha === 'string' ? refs.base_sha : null,
        headSha: typeof refs.head_sha === 'string' ? refs.head_sha : null,
        changedFiles,
        fileCount: total > 0 ? total : changedFiles.length,
      }
    },
    async listComments(cwd, number) {
      // Notes cover conversation comments, review threads and inline diff comments.
      const notes = await pages(cwd, await projectPath(cwd, `merge_requests/${number}/notes`))
      return notes
        .filter((note) => note.system !== true && typeof note.body === 'string')
        .map((note) => ({
          id: String(note.id ?? ''),
          user: text((note.author as { username?: unknown } | null | undefined)?.username),
          body: text(note.body),
        }))
    },
    postComment,
    async getPrBody(cwd, number) {
      return text((await mr(cwd, number)).description)
    },
    async updatePr(cwd, number, { title, body }) {
      await update(cwd, number, { title, description: body })
    },
    async closePr(cwd, number, reason) {
      await postComment(cwd, number, reason)
      await update(cwd, number, { state_event: 'close' })
    },
    async addLabel(cwd, number, label) {
      await update(cwd, number, { add_labels: label })
    },
    async removeLabel(cwd, number, label) {
      await update(cwd, number, { remove_labels: label })
    },
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, 'gitlab')
    },
    async uploadFile(cwd, path) {
      const form = new FormData()
      // Bun ignores the filename argument for a Bun.file blob and sends its full path.
      form.append('file', new File([await Bun.file(path).arrayBuffer()], basename(path)))
      const endpoint = await forge(cwd)
      const uploaded = (await forgeJson(
        endpoint,
        'POST',
        await projectPath(cwd, 'uploads'),
        form,
      )) as Record<string, unknown>
      // full_path is host-absolute; older GitLab answers only the project-relative url.
      const fullPath = text(uploaded.full_path)
      return fullPath === '' ? text(uploaded.url) : `${endpoint.base}${fullPath}`
    },
  }
}

/** A driver bound to `remote`: every forge CLI call and API URL targets that remote's repository. */
export function makePrDriver(kind: string, remote: string, exec: Exec = defaultExec): PrDriver {
  switch (kind) {
    case 'github':
      return githubPr(exec, remote)
    case 'gitlab':
      return gitlabPr(exec, remote)
    case 'forgejo':
      return forgejoPr(exec, remote)
    default:
      throw new NotImplementedDriverError('forge', kind)
  }
}
