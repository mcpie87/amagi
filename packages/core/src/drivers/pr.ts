import type { MergeStatus } from '../events.ts'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { NotImplementedDriverError } from '../factory.ts'
import { addPrLabels, type PrInfo, type PrMergeStatus, removePrLabel } from '../pr-check.ts'
import {
  forgeToken,
  forgeUrl,
  ghEnv,
  gitTokenConfig,
  glabEnv,
  parseRemote,
  teaEnv,
  teaRepoArgs,
} from './forge-cred.ts'

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
  /** Delete a branch on the remote; a branch already gone is not an error. */
  deleteBranch(cwd: string, remote: string, branch: string): Promise<void>
}

const GH_FIELDS =
  'number,title,body,url,headRefName,baseRefName,mergeable,mergeStateStatus,headRefOid,createdAt,updatedAt,labels'

/**
 * Pushes the task branch. Branch names derive from the task, so a requeued
 * task (say, its PR merged and then reverted) collides with the branch its
 * earlier attempt left on the remote; that copy is overwritten, pinned to the
 * sha just observed. A branch still backing an open PR is never overwritten.
 */
async function pushTaskBranch(
  exec: Exec,
  opts: Pick<CreatePrOptions, 'cwd' | 'remote' | 'branch'>,
  token: string | null,
  openPrOn: (branch: string) => Promise<{ number: number; url: string } | null>,
): Promise<void> {
  const { cwd, remote, branch } = opts
  const auth = await gitTokenConfig(exec, cwd, remote, token)
  const ref = `refs/heads/${branch}`
  const heads = await execOk(exec, ['git', ...auth, 'ls-remote', '--heads', remote, ref], { cwd })
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
  await execOk(
    exec,
    ['git', ...auth, 'push', '-u', `--force-with-lease=${ref}:${remoteSha}`, remote, branch],
    { cwd },
  )
}

async function deleteRemoteBranch(
  exec: Exec,
  cwd: string,
  remote: string,
  branch: string,
  token: string | null,
): Promise<void> {
  const auth = await gitTokenConfig(exec, cwd, remote, token)
  const r = await exec(['git', ...auth, 'push', remote, '--delete', branch], { cwd })
  if (r.exitCode !== 0 && !/remote ref does not exist/i.test(r.stderr)) {
    throw new Error(`deleting remote branch ${branch}: ${r.stderr.trim()}`)
  }
}

/**
 * Github PRs through `gh`, with Chise's token and an Amagi-owned GH_CONFIG_DIR
 * so gh never touches the operator's auth state. Token-only: without
 * GH_TOKEN/GITHUB_TOKEN in the process environment gh fails closed.
 */
function githubPr(exec: Exec, forgeRemote: string): PrDriver {
  let ownerRepo: string | null = null

  async function repoSlug(cwd: string): Promise<string> {
    if (ownerRepo === null) {
      ownerRepo = (
        await execOk(
          exec,
          ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
          { cwd, env: ghEnv(cwd, forgeRemote) },
        )
      ).trim()
    }
    return ownerRepo
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      await pushTaskBranch(
        exec,
        { cwd, remote, branch },
        forgeToken('github', cwd),
        async (head) => {
          const out = await execOk(
            exec,
            ['gh', 'pr', 'list', '--head', head, '--state', 'open', '--json', 'number,url'],
            { cwd, env: ghEnv(cwd, forgeRemote) },
          )
          return (JSON.parse(out) as Array<{ number: number; url: string }>)[0] ?? null
        },
      )
      for (const label of labels) {
        // --force makes create idempotent; failure (e.g. no write perms) is best effort
        await exec(['gh', 'label', 'create', label, '--force'], {
          cwd,
          env: ghEnv(cwd, forgeRemote),
        })
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
        { cwd, stdin: body, env: ghEnv(cwd, forgeRemote) },
      )
      const url = out.trim()
      return { url, number: Number(url.split('/').pop() ?? 0) }
    },
    async getPr(cwd, number) {
      const out = await execOk(
        exec,
        ['gh', 'pr', 'view', String(number), '--json', 'state', '--jq', '.state'],
        { cwd, env: ghEnv(cwd, forgeRemote) },
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
        env: ghEnv(cwd, forgeRemote),
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
          { cwd, env: ghEnv(cwd, forgeRemote) },
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
      return execOk(exec, ['gh', 'pr', 'diff', String(number)], {
        cwd,
        env: ghEnv(cwd, forgeRemote),
      })
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
          { cwd, env: ghEnv(cwd, forgeRemote) },
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
        env: ghEnv(cwd, forgeRemote),
      })
    },
    async closePr(cwd, number, reason) {
      await execOk(exec, ['gh', 'pr', 'close', String(number), '--comment', reason], {
        cwd,
        env: ghEnv(cwd, forgeRemote),
      })
    },
    async addLabel(cwd, number, label) {
      await addPrLabels(exec, cwd, forgeRemote, number, [label])
    },
    async removeLabel(cwd, number, label) {
      await removePrLabel(exec, cwd, forgeRemote, number, label)
    },
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, forgeToken('github', cwd))
    },
  }
}

type ForgejoRemote = { base: string; ownerRepo: string }

/** Forgejo PR writes use tea, with API reads for PR state and metadata. */
function forgejoPr(exec: Exec, forgeRemote: string): PrDriver {
  let remote: ForgejoRemote | null = null

  async function forge(cwd: string): Promise<ForgejoRemote> {
    if (remote !== null) return remote
    const url = await execOk(exec, ['git', 'remote', 'get-url', forgeRemote], { cwd })
    const parsed = parseRemote(url.trim())
    if (parsed === null) throw new Error(`cannot parse forge remote: ${url.trim()}`)
    remote = { ...parsed, base: forgeUrl('forgejo', cwd) ?? parsed.base }
    return remote
  }

  async function forgeTokenOrThrow(cwd: string): Promise<string> {
    const t = forgeToken('forgejo', cwd)
    if (t === null) {
      throw new Error(
        'forgejo token missing: set it in the repository settings or FORGEJO_TOKEN in the amagi process environment',
      )
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
        authorization: `token ${await forgeTokenOrThrow(cwd)}`,
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

  async function listOpenPrs(cwd: string): Promise<PrInfo[]> {
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
      createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
      labels: ((item.labels as Array<{ name?: string }> | undefined) ?? []).map(
        (l) => l.name ?? '',
      ),
    }))
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
      await forgeTokenOrThrow(cwd)
      await pushTaskBranch(
        exec,
        { cwd, remote: remoteName, branch },
        forgeToken('forgejo', cwd),
        async (head) => (await listOpenPrs(cwd)).find((pr) => pr.headRefName === head) ?? null,
      )
      for (const label of labels) {
        // best effort: a label that exists or a run without write perms is not fatal
        await api(cwd, 'POST', `repos/${(await forge(cwd)).ownerRepo}/labels`, {
          name: label,
          color: 'A0A0A0',
        }).catch(() => {})
      }
      await execOk(
        exec,
        [
          'tea',
          'pr',
          'create',
          ...teaRepoArgs(cwd, forgeRemote),
          '--base',
          base,
          '--head',
          branch,
          '--title',
          title,
          '--description',
          body,
          ...(labels.length === 0 ? [] : ['--labels', labels.join(',')]),
        ],
        { cwd, env: await teaEnv(exec, cwd, forgeRemote) },
      )
      const created = (await listOpenPrs(cwd)).find((pr) => pr.headRefName === branch)
      if (created === undefined) {
        throw new Error(`tea created a pull request for ${branch}, but it could not be found`)
      }
      return { url: created.url, number: created.number }
    },
    async getPr(cwd, number) {
      const pr = await api(cwd, 'GET', `repos/${(await forge(cwd)).ownerRepo}/pulls/${number}`)
      if (pr.merged === true || pr.state === 'merged') return 'merged'
      if (pr.state === 'closed') return 'closed'
      return 'open'
    },
    listOpenPrs,
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
      await forgeTokenOrThrow(cwd)
      await execOk(
        exec,
        ['tea', 'comment', ...teaRepoArgs(cwd, forgeRemote), String(number), body],
        {
          cwd,
          env: await teaEnv(exec, cwd, forgeRemote),
        },
      )
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
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, forgeToken('forgejo', cwd))
    },
  }
}

const GITLAB_PAGE = 100

/**
 * GitLab merge requests through `glab`, with the repo's token and an
 * Amagi-owned GLAB_CONFIG_DIR so glab never touches the operator's login.
 * Everything but creation and the diff goes through `glab api`, whose `:id`
 * placeholder resolves the project from the repo `cwd` is in.
 */
function gitlabPr(exec: Exec, forgeRemote: string): PrDriver {
  async function api(cwd: string, args: readonly string[]): Promise<unknown> {
    const out = await execOk(exec, ['glab', 'api', ...args], {
      cwd,
      env: glabEnv(cwd, forgeRemote),
    })
    return out.trim() === '' ? null : (JSON.parse(out) as unknown)
  }

  // Explicit page walk: glab's --paginate concatenates raw JSON arrays.
  async function pages(cwd: string, path: string): Promise<Array<Record<string, unknown>>> {
    const all: Array<Record<string, unknown>> = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const raw = await api(cwd, [`${path}${sep}per_page=${GITLAB_PAGE}&page=${page}`])
      const items = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
      all.push(...items)
      if (items.length < GITLAB_PAGE) return all
    }
  }

  async function mr(cwd: string, number: number): Promise<Record<string, unknown>> {
    const raw = await api(cwd, [`projects/:id/merge_requests/${number}`])
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  }

  const text = (value: unknown): string => (typeof value === 'string' ? value : '')

  /** Maps GitLab's has_conflicts + merge_status onto the shared shape. */
  function mergeFields(item: Record<string, unknown>): PrMergeStatus {
    if (item.has_conflicts === true) return { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }
    if (item.merge_status === 'can_be_merged') {
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
    return (await pages(cwd, `projects/:id/merge_requests?state=opened${filter}`)).map(toPrInfo)
  }

  async function postComment(cwd: string, number: number, body: string): Promise<void> {
    await api(cwd, [
      '--method',
      'POST',
      `projects/:id/merge_requests/${number}/notes`,
      '-f',
      `body=${body}`,
    ])
  }

  async function update(cwd: string, number: number, field: string): Promise<void> {
    await api(cwd, ['--method', 'PUT', `projects/:id/merge_requests/${number}`, '-f', field])
  }

  return {
    async createPr({ cwd, branch, base, remote, title, body, labels }) {
      await pushTaskBranch(
        exec,
        { cwd, remote, branch },
        forgeToken('gitlab', cwd),
        async (head) => (await openMrs(cwd, head))[0] ?? null,
      )
      // GitLab creates labels on first use, so there is no create-on-demand step.
      await execOk(
        exec,
        [
          'glab',
          'mr',
          'create',
          '--source-branch',
          branch,
          '--target-branch',
          base,
          '--title',
          title,
          '--description',
          body,
          ...(labels.length === 0 ? [] : ['--label', labels.join(',')]),
          '--yes',
        ],
        { cwd, env: glabEnv(cwd, forgeRemote) },
      )
      const created = (await openMrs(cwd, branch))[0]
      if (created === undefined) {
        throw new Error(`glab created a merge request for ${branch}, but it could not be found`)
      }
      return { url: created.url, number: created.number }
    },
    async getPr(cwd, number) {
      const state = (await mr(cwd, number)).state
      if (state === 'merged') return 'merged'
      if (state === 'closed' || state === 'locked') return 'closed'
      return 'open'
    },
    listOpenPrs: (cwd) => openMrs(cwd),
    async getMergeStatus(cwd, number) {
      const { mergeable } = mergeFields(await mr(cwd, number))
      if (mergeable === 'CONFLICTING') return 'conflicted'
      if (mergeable === 'MERGEABLE') return 'mergeable'
      return 'unknown'
    },
    async getPrDiff(cwd, number) {
      return execOk(exec, ['glab', 'mr', 'diff', String(number), '--raw'], {
        cwd,
        env: glabEnv(cwd, forgeRemote),
      })
    },
    async listComments(cwd, number) {
      // Notes cover conversation comments, review threads and inline diff comments.
      const notes = await pages(cwd, `projects/:id/merge_requests/${number}/notes`)
      return notes
        .filter((note) => note.system !== true && typeof note.body === 'string')
        .map((note) => ({
          id: String(note.id ?? ''),
          user: text((note.author as { username?: unknown } | null | undefined)?.username),
          body: text(note.body),
        }))
    },
    postComment,
    async closePr(cwd, number, reason) {
      await postComment(cwd, number, reason)
      await update(cwd, number, 'state_event=close')
    },
    async addLabel(cwd, number, label) {
      await update(cwd, number, `add_labels=${label}`)
    },
    async removeLabel(cwd, number, label) {
      await update(cwd, number, `remove_labels=${label}`)
    },
    async deleteBranch(cwd, remote, branch) {
      await deleteRemoteBranch(exec, cwd, remote, branch, forgeToken('gitlab', cwd))
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
