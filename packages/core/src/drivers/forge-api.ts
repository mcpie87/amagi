import type { Config } from '../config.ts'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { forgeToken, forgeUrl, parseRemote } from './forge-cred.ts'

type ForgeKind = Config['forge']['kind']

const FORGE_LABELS: Record<ForgeKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  forgejo: 'Forgejo',
}

/** The env var a forge's token falls back to, named in the missing-token error. */
const TOKEN_ENV: Record<ForgeKind, string> = {
  github: 'GH_TOKEN',
  gitlab: 'GITLAB_TOKEN',
  forgejo: 'FORGEJO_TOKEN',
}

/** A non-2xx forge API answer; `status` lets a read tolerate a 404 and nothing else. */
export class ForgeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** No token resolves for the forge; the message names where to set one. */
export class ForgeTokenMissingError extends Error {}

/** Whether a forge call failed for want of a usable token: none set, or one the forge rejected. */
export function isForgeAuthError(err: unknown): boolean {
  if (err instanceof ForgeTokenMissingError) return true
  return err instanceof ForgeApiError && (err.status === 401 || err.status === 403)
}

/** A repository on a forge, resolved for API calls. */
export type ForgeEndpoint = {
  kind: ForgeKind
  /** Web base URL, e.g. https://git.example.com. */
  base: string
  /** Root every request path is relative to, e.g. https://git.example.com/api/v1. */
  apiRoot: string
  /** owner/repo (or group/sub/repo) path from the forge remote. */
  ownerRepo: string
  token: string
}

/** GitHub.com serves its API from its own host; every other forge nests it under the web base. */
function apiRoot(kind: ForgeKind, base: string): string {
  switch (kind) {
    case 'github':
      return new URL(base).hostname === 'github.com' ? 'https://api.github.com' : `${base}/api/v3`
    case 'gitlab':
      return `${base}/api/v4`
    case 'forgejo':
      return `${base}/api/v1`
  }
}

function authHeaders(kind: ForgeKind, token: string): Record<string, string> {
  switch (kind) {
    case 'github':
      return { authorization: `Bearer ${token}` }
    case 'gitlab':
      return { 'PRIVATE-TOKEN': token }
    case 'forgejo':
      return { authorization: `token ${token}` }
  }
}

/**
 * The `remote` of the repo at `cwd` as a forge endpoint. The web base is the
 * credential's URL when it names one, else the remote's host. Throws naming
 * the repository setting and env var when no token resolves.
 */
export async function resolveForge(
  kind: ForgeKind,
  cwd: string,
  remote: string,
  exec: Exec = defaultExec,
): Promise<ForgeEndpoint> {
  const token = forgeToken(kind, cwd)
  if (token === null) {
    throw new ForgeTokenMissingError(
      `${FORGE_LABELS[kind]} token missing: set it in the repository settings or ${TOKEN_ENV[kind]} in the amagi process environment`,
    )
  }
  const url = (await execOk(exec, ['git', 'remote', 'get-url', remote], { cwd })).trim()
  const parsed = parseRemote(url)
  if (parsed === null) throw new Error(`cannot parse forge remote: ${url}`)
  const base = forgeUrl(kind, cwd) ?? parsed.base
  return { kind, base, apiRoot: apiRoot(kind, base), ownerRepo: parsed.ownerRepo, token }
}

/**
 * One request to the forge API; `path` is relative to the API root. A non-2xx
 * answer throws ForgeApiError. A body, when given, is sent as JSON; `headers`
 * are added to the defaults (e.g. GitHub's diff media type).
 */
export async function forgeFetch(
  forge: ForgeEndpoint,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  // fetch sets the multipart content-type with its boundary itself.
  const form = body instanceof FormData
  const res = await fetch(`${forge.apiRoot}/${path}`, {
    method,
    headers: {
      ...authHeaders(forge.kind, forge.token),
      ...(body === undefined || form ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: form ? body : JSON.stringify(body) }),
  })
  if (!res.ok) {
    throw new ForgeApiError(
      `${forge.kind} api ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`,
      res.status,
    )
  }
  return res
}

/** The parsed JSON answer of forgeFetch; null when the answer has no body. */
export async function forgeJson(
  forge: ForgeEndpoint,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const text = await (await forgeFetch(forge, method, path, body)).text()
  return text.trim() === '' ? null : JSON.parse(text)
}

function hasNextPage(kind: ForgeKind, res: Response, collected: number): boolean {
  switch (kind) {
    case 'github':
      return /\brel="?next"?/.test(res.headers.get('link') ?? '')
    case 'gitlab':
      return (res.headers.get('x-next-page') ?? '') !== ''
    // Forgejo clamps `limit` to its own maximum, so a short page is not the last one.
    case 'forgejo': {
      const total = res.headers.get('x-total-count')
      return total === null || collected < Number(total)
    }
  }
}

/**
 * Every item of a collection path, walking pages until the forge reports no
 * next one. An empty page also ends the walk, so a server that never reports
 * an end cannot loop forever.
 */
export async function forgePages(
  forge: ForgeEndpoint,
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = []
  const sep = path.includes('?') ? '&' : '?'
  const size = forge.kind === 'forgejo' ? 'limit=50' : 'per_page=100'
  for (let page = 1; ; page++) {
    const res = await forgeFetch(forge, 'GET', `${path}${sep}${size}&page=${page}`)
    const raw: unknown = await res.json()
    const batch = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
    all.push(...batch)
    if (batch.length === 0 || !hasNextPage(forge.kind, res, all.length)) return all
  }
}
