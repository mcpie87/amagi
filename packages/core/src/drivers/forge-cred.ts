import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import * as z from 'zod'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { stateHome } from '../paths.ts'

/** The forges Amagi can talk to; mirrors ForgeKind from config.ts. */
const FORGE_KINDS = ['github', 'gitlab', 'forgejo'] as const
type ForgeKind = (typeof FORGE_KINDS)[number]

/** Tea login name in the Amagi-provisioned profile; a single login per isolated config. */
export const TEA_LOGIN = 'amagi'

const FORGE_LABELS: Record<ForgeKind, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  forgejo: 'Forgejo',
}

/**
 * A named forge token as the dashboard sees it: the token itself never leaves
 * the server. `url` is the forge's web base URL; null means derive it from the
 * repo's origin remote.
 */
export type ForgeCredential = { id: string; kind: ForgeKind; name: string; url: string | null }

const StoredCredential = z.object({
  id: z.string().min(1),
  kind: z.enum(FORGE_KINDS),
  name: z.string(),
  token: z.string().min(1),
  url: z.string().min(1).optional(),
})
type StoredCredential = z.infer<typeof StoredCredential>

const TokenStore = z.object({
  credentials: z.array(StoredCredential),
  /** Credential id each repo root picked, per forge kind. */
  repos: z.record(z.string(), z.partialRecord(z.enum(FORGE_KINDS), z.string())),
})
type TokenStore = z.infer<typeof TokenStore>

/** The pre-credentials layout: one raw token per forge kind, keyed by repo root. */
const LegacyTokenStore = z.record(
  z.string(),
  z.partialRecord(z.enum(FORGE_KINDS), z.string().min(1)),
)

function forgeStateDir(): string {
  return join(stateHome(), 'amagi', 'forge')
}

/**
 * Named forge credentials and each repo's pick of them, set from the
 * dashboard. Lives in Amagi's state dir, never in `.amagi/config.toml`,
 * which is committed with the repo.
 */
export function forgeTokensPath(): string {
  return join(forgeStateDir(), 'tokens.json')
}

/**
 * Folds legacy per-repo tokens into credentials, one per distinct token.
 * Ids derive from the token so repeated reads of an unmigrated file agree.
 */
function migrateLegacy(legacy: z.infer<typeof LegacyTokenStore>): TokenStore {
  const store: TokenStore = { credentials: [], repos: {} }
  for (const [root, tokens] of Object.entries(legacy)) {
    for (const kind of FORGE_KINDS) {
      const token = tokens[kind]
      if (token === undefined) continue
      let credential = store.credentials.find((c) => c.kind === kind && c.token === token)
      if (credential === undefined) {
        const id = createHash('sha256').update(`${kind}:${token}`).digest('hex').slice(0, 12)
        credential = { id, kind, name: `${FORGE_LABELS[kind]} (${basename(root)})`, token }
        store.credentials.push(credential)
      }
      store.repos[root] = { ...store.repos[root], [kind]: credential.id }
    }
  }
  return store
}

function readTokenStore(): TokenStore {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(forgeTokensPath(), 'utf8'))
  } catch {
    return { credentials: [], repos: {} }
  }
  const current = TokenStore.safeParse(raw)
  if (current.success) return current.data
  const legacy = LegacyTokenStore.safeParse(raw)
  return legacy.success ? migrateLegacy(legacy.data) : { credentials: [], repos: {} }
}

function writeTokenStore(store: TokenStore): void {
  const path = forgeTokensPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies mode on create; a pre-existing file keeps its own.
  chmodSync(path, 0o600)
}

const publicCredential = ({ id, kind, name, url }: StoredCredential): ForgeCredential => ({
  id,
  kind,
  name,
  url: url ?? null,
})

/** Trailing slashes dropped, so `${url}/api/v1` and host comparisons stay clean. */
const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '')

export function listForgeCredentials(): ForgeCredential[] {
  return readTokenStore().credentials.map(publicCredential)
}

export function addForgeCredential(
  kind: ForgeKind,
  name: string,
  token: string,
  url: string | null = null,
): ForgeCredential {
  const store = readTokenStore()
  const credential: StoredCredential = { id: randomUUID(), kind, name, token }
  if (url !== null) credential.url = normalizeUrl(url)
  store.credentials.push(credential)
  writeTokenStore(store)
  return publicCredential(credential)
}

/**
 * Renames, rotates or re-points a credential; every repo using it picks up the
 * change. A null `url` goes back to deriving it from origin. Null when unknown.
 */
export function updateForgeCredential(
  id: string,
  patch: { name?: string | undefined; token?: string | undefined; url?: string | null | undefined },
): ForgeCredential | null {
  const store = readTokenStore()
  const credential = store.credentials.find((c) => c.id === id)
  if (credential === undefined) return null
  if (patch.name !== undefined) credential.name = patch.name
  if (patch.token !== undefined) credential.token = patch.token
  if (patch.url === null) delete credential.url
  else if (patch.url !== undefined) credential.url = normalizeUrl(patch.url)
  writeTokenStore(store)
  return publicCredential(credential)
}

/** Deletes a credential and every repo's pick of it. False when unknown. */
export function removeForgeCredential(id: string): boolean {
  const store = readTokenStore()
  const before = store.credentials.length
  store.credentials = store.credentials.filter((c) => c.id !== id)
  if (store.credentials.length === before) return false
  for (const [root, picks] of Object.entries(store.repos)) {
    const kept = Object.fromEntries(Object.entries(picks).filter(([, pick]) => pick !== id))
    if (Object.keys(kept).length === 0) delete store.repos[root]
    else store.repos[root] = kept
  }
  writeTokenStore(store)
  return true
}

/**
 * Points a repo root at a credential for one forge kind, or with null drops
 * the pick. False when the id is unknown or belongs to another forge.
 */
export function pickForgeCredential(repoRoot: string, kind: ForgeKind, id: string | null): boolean {
  const store = readTokenStore()
  if (id !== null && !store.credentials.some((c) => c.id === id && c.kind === kind)) return false
  const root = resolve(repoRoot)
  const { [kind]: _dropped, ...rest } = store.repos[root] ?? {}
  const next = id === null ? rest : { ...rest, [kind]: id }
  if (Object.keys(next).length === 0) delete store.repos[root]
  else store.repos[root] = next
  writeTokenStore(store)
  return true
}

const repoRoots = new Map<string, string | null>()

/**
 * Main repo root for any directory inside it or inside one of its worktrees,
 * via git's common dir, so a token stored for the repo also covers the
 * worktrees Amagi runs agents in. Cached: roots do not move under a process.
 */
function repoRootOf(cwd: string): string | null {
  const key = resolve(cwd)
  const cached = repoRoots.get(key)
  if (cached !== undefined) return cached
  let root: string | null = null
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: key,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const common = r.exitCode === 0 ? r.stdout.toString().trim() : ''
    if (common !== '') root = basename(common) === '.git' ? dirname(common) : common
  } catch {
    root = null
  }
  repoRoots.set(key, root)
  return root
}

function envForgeToken(kind: ForgeKind): string | null {
  switch (kind) {
    case 'github':
      return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null
    case 'gitlab':
      return process.env.GITLAB_TOKEN ?? process.env.GITLAB_ACCESS_TOKEN ?? null
    case 'forgejo':
      return (
        process.env.FORGEJO_TOKEN ?? process.env.GITEA_SERVER_TOKEN ?? process.env.TEA_TOKEN ?? null
      )
  }
}

/**
 * `picked`: the repo chose this credential. `only`: no pick, and it is the
 * sole credential for the forge. `environment`: the process env var.
 */
export type ForgeTokenSource = 'picked' | 'only' | 'environment' | null

export type ForgeTokenState = { credential: string | null; source: ForgeTokenSource }

function resolveCredential(
  store: TokenStore,
  root: string | null,
  kind: ForgeKind,
): { credential: StoredCredential; source: 'picked' | 'only' } | null {
  const pick = root === null ? undefined : store.repos[root]?.[kind]
  const picked = store.credentials.find((c) => c.id === pick && c.kind === kind)
  if (picked !== undefined) return { credential: picked, source: 'picked' }
  const ofKind = store.credentials.filter((c) => c.kind === kind)
  return ofKind.length === 1 && ofKind[0] !== undefined
    ? { credential: ofKind[0], source: 'only' }
    : null
}

/** Which credential each forge uses for a repo root, and why, without revealing any token. */
export function forgeTokenStates(repoRoot: string): Record<ForgeKind, ForgeTokenState> {
  const store = readTokenStore()
  const root = resolve(repoRoot)
  const state = (kind: ForgeKind): ForgeTokenState => {
    const hit = resolveCredential(store, root, kind)
    if (hit !== null) return { credential: hit.credential.id, source: hit.source }
    return { credential: null, source: envForgeToken(kind) !== null ? 'environment' : null }
  }
  return { github: state('github'), gitlab: state('gitlab'), forgejo: state('forgejo') }
}

/**
 * Bot token for a forge: the credential the repo `cwd` belongs to picked,
 * else the only credential for that forge, else the Amagi process
 * environment. Never a CLI login: gh, glab and tea are used strictly
 * non-interactively with it.
 */
export function forgeToken(kind: ForgeKind, cwd?: string): string | null {
  const root = cwd === undefined ? null : repoRootOf(cwd)
  return resolveCredential(readTokenStore(), root, kind)?.credential.token ?? envForgeToken(kind)
}

/**
 * Web base URL the resolved credential for `cwd` names, e.g.
 * `https://git.example.com`. Null when it names none or comes from the
 * environment: callers then derive the URL from the origin remote.
 */
export function forgeUrl(kind: ForgeKind, cwd?: string): string | null {
  const root = cwd === undefined ? null : repoRootOf(cwd)
  return resolveCredential(readTokenStore(), root, kind)?.credential.url ?? null
}

/** Where Amagi keeps gh's own config, so gh never reads the operator's ~/.config/gh. */
export function ghConfigDir(): string {
  return join(forgeStateDir(), 'github')
}

/**
 * The XDG_CONFIG_HOME Amagi points tea at, so tea never reads the operator's
 * config. One profile per token: tea keeps a single login per config, and
 * repos may carry different tokens.
 */
export function teaXdgHome(token: string | null, url: string | null = null): string {
  const base = join(forgeStateDir(), 'tea')
  if (token === null) return base
  // Keyed on the URL too, so re-pointing a credential provisions a fresh login.
  const key = url === null ? token : `${url}\n${token}`
  return join(base, createHash('sha256').update(key).digest('hex').slice(0, 16))
}

/**
 * `owner/repo` and web base URL of `remote` in the repo at `cwd`, or null when
 * the remote is missing or unparseable. Synchronous so the env builders below
 * stay usable from sync call sites; one local git call, no network.
 */
function remoteRepo(cwd: string, remote: string): { base: string; ownerRepo: string } | null {
  try {
    const r = Bun.spawnSync(['git', 'remote', 'get-url', remote], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return r.exitCode === 0 ? parseRemote(r.stdout.toString()) : null
  } catch {
    return null
  }
}

/** Where each forge lives when its credential names no URL; Forgejo has no public default. */
const PUBLIC_HOST: Record<ForgeKind, string | null> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  forgejo: null,
}

/**
 * Hostname of the `kind` forge for the repo at `cwd`: the resolved
 * credential's URL, else the forge's public host. Null when unknown.
 */
export function forgeHostname(kind: ForgeKind, cwd: string): string | null {
  const url = forgeUrl(kind, cwd)
  return url === null ? PUBLIC_HOST[kind] : new URL(url).hostname
}

/** Hostname a git remote URL points at, or null when unparseable. */
export function remoteHostname(url: string): string | null {
  const parsed = parseRemote(url)
  return parsed === null ? null : new URL(parsed.base).hostname
}

/** Name and fetch URL of every remote of the repo at `cwd`; empty when git fails. */
export function gitRemoteUrls(cwd: string): { name: string; url: string }[] {
  try {
    const r = Bun.spawnSync(['git', 'remote', '-v'], { cwd, stdout: 'pipe', stderr: 'pipe' })
    if (r.exitCode !== 0) return []
    return r.stdout
      .toString()
      .split('\n')
      .flatMap((line) => {
        const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/)
        return m?.[1] === undefined || m[2] === undefined ? [] : [{ name: m[1], url: m[2] }]
      })
  } catch {
    return []
  }
}

/**
 * The remote of the repo at `cwd` that points at the `kind` forge, matched
 * by hostname so ssh remotes on another port still match. Several matches
 * (fork plus upstream) prefer origin, else the first; null when none match.
 */
export function matchForgeRemote(cwd: string, kind: ForgeKind): string | null {
  const host = forgeHostname(kind, cwd)
  if (host === null) return null
  const matches = gitRemoteUrls(cwd).filter((r) => remoteHostname(r.url) === host)
  return (matches.find((r) => r.name === 'origin') ?? matches[0])?.name ?? null
}

/**
 * Env for a gh subprocess: Chise's token and an Amagi-owned GH_CONFIG_DIR.
 * The config dir is set even without a token so gh fails closed instead of
 * silently falling back to whatever the operator has in ~/.config/gh.
 * GH_REPO pins gh to `remote`: left alone, gh prefers a remote named
 * upstream or github over origin.
 */
export function ghEnv(cwd: string, remote: string): Record<string, string> {
  const dir = ghConfigDir()
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = { GH_CONFIG_DIR: dir }
  const token = forgeToken('github', cwd)
  if (token !== null) env.GH_TOKEN = token
  const repo = remoteRepo(cwd, remote)
  if (repo !== null) env.GH_REPO = `${new URL(repo.base).host}/${repo.ownerRepo}`
  return env
}

/** Where Amagi keeps glab's own config, so glab never reads the operator's ~/.config/glab-cli. */
export function glabConfigDir(): string {
  return join(forgeStateDir(), 'gitlab')
}

/**
 * Env for a glab subprocess: the repo's GitLab token and an Amagi-owned
 * GLAB_CONFIG_DIR, set even without a token so glab fails closed.
 * REMOTE_ALIAS and GLAB_REMOTE_ALIAS pin glab to `remote` instead of its remote-name
 * preference. A credential URL sends API calls there instead of to the
 * remote's host.
 */
export function glabEnv(cwd: string, remote: string): Record<string, string> {
  const dir = glabConfigDir()
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = {
    GLAB_CONFIG_DIR: dir,
    GLAB_NO_PROMPT: 'true',
    // glab 1.x reads REMOTE_ALIAS; 2.x prefers GLAB_REMOTE_ALIAS.
    REMOTE_ALIAS: remote,
    GLAB_REMOTE_ALIAS: remote,
  }
  const token = forgeToken('gitlab', cwd)
  if (token !== null) env.GITLAB_TOKEN = token
  const url = forgeUrl('gitlab', cwd)
  if (url !== null) {
    const { protocol, host, pathname } = new URL(url)
    env.GITLAB_API_HOST = `${host}${pathname.replace(/\/+$/, '')}`
    env.GLAB_API_PROTOCOL = protocol.replace(/:$/, '')
  }
  return env
}

/**
 * Splits a git remote URL into the forge base URL (https unless the remote
 * says http) and the owner/repo slug. Handles https, http, ssh:// and the
 * git@host:owner/repo.git scp form.
 */
export function parseRemote(url: string): { base: string; ownerRepo: string } | null {
  const s = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]*@/, '')
  const slash = s.indexOf('/')
  const colon = s.indexOf(':')
  const portEnd = slash === -1 ? s.length : slash
  const isPort = colon !== -1 && /^\d+$/.test(s.slice(colon + 1, portEnd))
  const scp = !isPort && colon !== -1 && (slash === -1 || colon < slash)
  const host = isPort || scp ? s.slice(0, colon) : slash !== -1 ? s.slice(0, slash) : s
  const port = isPort ? s.slice(colon, portEnd) : ''
  const path = isPort
    ? s.slice(portEnd + 1)
    : scp
      ? s.slice(colon + 1)
      : slash !== -1
        ? s.slice(slash + 1)
        : ''
  if (host === '' || path === '') return null
  const proto = url.trim().startsWith('http://') ? 'http' : 'https'
  return { base: `${proto}://${host}${port}`, ownerRepo: path.replace(/\.git$/, '') }
}

/**
 * The insteadOf rewrite pair that makes a remote authenticate with the token:
 * `from` is the configured URL prefix, `to` the same prefix carrying the token
 * as basic auth. Git rewrites any URL starting with `from` to start with `to`,
 * keeping the rest (and the .git suffix) intact.
 */
export function gitRewrite(url: string, token: string): { from: string; to: string } | null {
  const t = url.trim()
  const scp = t.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
  const urlish = t.match(/^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i)
  if (scp !== null && urlish === null) {
    if (scp[3] === '') return null
    return { from: `${scp[1] ?? ''}${scp[2]}:`, to: `https://x-access-token:${token}@${scp[2]}/` }
  }
  if (urlish !== null) {
    const scheme = urlish[1] === 'ssh' ? 'https' : urlish[1]
    const hostPart = urlish[2] ?? ''
    const path = urlish[3] ?? ''
    if (hostPart === '' || path === '') return null
    const bare = hostPart.includes('@') ? hostPart.slice(hostPart.lastIndexOf('@') + 1) : hostPart
    return {
      from: `${urlish[1]}://${hostPart}/`,
      to: `${scheme}://x-access-token:${token}@${bare}/`,
    }
  }
  return null
}

/**
 * Git config environment entries so push/fetch over `remote` authenticate
 * with the forge token without exposing it in process argv. Empty without a
 * token (or an unparseable remote), so git keeps its remote and prompts.
 */
export async function gitTokenConfig(
  exec: Exec,
  cwd: string,
  remote: string,
  token: string | null,
): Promise<Record<string, string>> {
  if (token === null) return {}
  const url = await execOk(exec, ['git', 'remote', 'get-url', remote], { cwd }).catch(() => '')
  const rewrite = gitRewrite(url.trim(), token)
  if (rewrite === null) return {}
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${rewrite.to}.insteadOf`,
    GIT_CONFIG_VALUE_0: rewrite.from,
  }
}

/** Base URL of `remote`, for provisioning a tea login. */
async function remoteBaseUrl(exec: Exec, cwd: string, remote: string): Promise<string | null> {
  const url = await execOk(exec, ['git', 'remote', 'get-url', remote], { cwd }).catch(() => '')
  return parseRemote(url.trim())?.base ?? null
}

/**
 * Provisions a single tea login into Amagi's own XDG_CONFIG_HOME from the
 * token, so the operator never needs `tea login`. Best effort: an existing
 * profile (or a missing server URL or token) is left alone, and tea then
 * fails closed with "no available login" instead of touching operator config.
 */
async function ensureTeaLogin(
  exec: Exec,
  cwd: string,
  remote: string,
  token: string | null,
  configured: string | null,
): Promise<void> {
  const cfg = join(teaXdgHome(token, configured), 'tea', 'config.yml')
  if (existsSync(cfg)) return
  const url = configured ?? process.env.GITEA_SERVER_URL ?? (await remoteBaseUrl(exec, cwd, remote))
  if (token === null || url === null) return
  mkdirSync(dirname(cfg), { recursive: true, mode: 0o700 })
  writeFileSync(
    cfg,
    `${JSON.stringify({ logins: [{ name: TEA_LOGIN, url, token, default: true }] }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/** Env for a tea subprocess: Amagi's XDG_CONFIG_HOME with a login provisioned from the token. */
export async function teaEnv(
  exec: Exec = defaultExec,
  cwd: string,
  remote: string,
): Promise<Record<string, string>> {
  const token = forgeToken('forgejo', cwd)
  const url = forgeUrl('forgejo', cwd)
  const env: Record<string, string> = { XDG_CONFIG_HOME: teaXdgHome(token, url) }
  await ensureTeaLogin(exec, cwd, remote, token, url)
  return env
}

/**
 * tea flags that pin a command to `remote`'s repository through Amagi's
 * login. Without them tea picks the repo from whichever remote matches a
 * login's host, which is not necessarily `remote`.
 */
export function teaRepoArgs(cwd: string, remote: string): string[] {
  const repo = remoteRepo(cwd, remote)
  return repo === null ? [] : ['--login', TEA_LOGIN, '--repo', repo.ownerRepo]
}
