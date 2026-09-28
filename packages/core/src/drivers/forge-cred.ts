import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { stateHome } from '../paths.ts'

/** The forges Amagi can talk to; mirrors ForgeKind from config.ts. */
type ForgeKind = 'github' | 'gitlab' | 'forgejo'

/** Tea login name in the Amagi-provisioned profile; a single login per isolated config. */
export const TEA_LOGIN = 'amagi'

export type ForgeTokens = Partial<Record<ForgeKind, string>>

function forgeStateDir(): string {
  return join(stateHome(), 'amagi', 'forge')
}

/**
 * Per-repository forge tokens set from the dashboard, keyed by repo root.
 * Lives in Amagi's state dir, never in `.amagi/config.toml`, which is
 * committed with the repo.
 */
export function forgeTokensPath(): string {
  return join(forgeStateDir(), 'tokens.json')
}

function readTokenStore(): Record<string, ForgeTokens> {
  try {
    const parsed = JSON.parse(readFileSync(forgeTokensPath(), 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, ForgeTokens>)
      : {}
  } catch {
    return {}
  }
}

/** Tokens stored for a repo root; empty when none were set. */
export function storedForgeTokens(repoRoot: string): ForgeTokens {
  return readTokenStore()[resolve(repoRoot)] ?? {}
}

/** Stores (or with null, clears) one forge token for a repo root. */
export function setStoredForgeToken(repoRoot: string, kind: ForgeKind, token: string | null): void {
  const store = readTokenStore()
  const root = resolve(repoRoot)
  const { [kind]: _dropped, ...rest } = store[root] ?? {}
  const next: ForgeTokens = token === null ? rest : { ...rest, [kind]: token }
  if (Object.keys(next).length === 0) delete store[root]
  else store[root] = next
  const path = forgeTokensPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies mode on create; a pre-existing file keeps its own.
  chmodSync(path, 0o600)
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

export type ForgeTokenSource = 'repository' | 'environment' | null

/** Where each forge's token for a repo root comes from, without revealing any token. */
export function forgeTokenSources(repoRoot: string): Record<ForgeKind, ForgeTokenSource> {
  const stored = storedForgeTokens(repoRoot)
  const source = (kind: ForgeKind): ForgeTokenSource =>
    stored[kind] !== undefined ? 'repository' : envForgeToken(kind) !== null ? 'environment' : null
  return { github: source('github'), gitlab: source('gitlab'), forgejo: source('forgejo') }
}

/**
 * Bot token for a forge. A token stored for the repo `cwd` belongs to (set in
 * the dashboard) wins; otherwise the Amagi process environment. Never a CLI
 * login: gh, glab and tea are used strictly non-interactively with it.
 */
export function forgeToken(kind: ForgeKind, cwd?: string): string | null {
  const root = cwd === undefined ? null : repoRootOf(cwd)
  const stored = root === null ? undefined : storedForgeTokens(root)[kind]
  return stored ?? envForgeToken(kind)
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
export function teaXdgHome(token: string | null): string {
  const base = join(forgeStateDir(), 'tea')
  if (token === null) return base
  return join(base, createHash('sha256').update(token).digest('hex').slice(0, 16))
}

/**
 * Env for a gh subprocess: Chise's token and an Amagi-owned GH_CONFIG_DIR.
 * The config dir is set even without a token so gh fails closed instead of
 * silently falling back to whatever the operator has in ~/.config/gh.
 */
export function ghEnv(cwd?: string): Record<string, string> {
  const dir = ghConfigDir()
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = { GH_CONFIG_DIR: dir }
  const token = forgeToken('github', cwd)
  if (token !== null) env.GH_TOKEN = token
  return env
}

/** Where Amagi keeps glab's own config, so glab never reads the operator's ~/.config/glab-cli. */
export function glabConfigDir(): string {
  return join(forgeStateDir(), 'gitlab')
}

/**
 * Env for a glab subprocess: the repo's GitLab token and an Amagi-owned
 * GLAB_CONFIG_DIR, set even without a token so glab fails closed.
 */
export function glabEnv(cwd?: string): Record<string, string> {
  const dir = glabConfigDir()
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = { GLAB_CONFIG_DIR: dir, GLAB_NO_PROMPT: 'true' }
  const token = forgeToken('gitlab', cwd)
  if (token !== null) env.GITLAB_TOKEN = token
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
 * git -c args so push/fetch over `remote` authenticate with the forge token
 * instead of whatever credential helper or ssh key the operator configured.
 * Empty without a token (or an unparseable remote), so git keeps its remote
 * and prompts; Amagi never blocks on that prompt in the unattended path.
 */
export async function gitTokenConfig(
  exec: Exec,
  cwd: string,
  remote: string,
  token: string | null,
): Promise<string[]> {
  if (token === null) return []
  const url = await execOk(exec, ['git', 'remote', 'get-url', remote], { cwd }).catch(() => '')
  const rewrite = gitRewrite(url.trim(), token)
  if (rewrite === null) return []
  return ['-c', `url.${rewrite.to}.insteadOf=${rewrite.from}`]
}

/** Base URL of the configured origin remote, for provisioning a tea login. */
async function remoteBaseUrl(exec: Exec, cwd: string): Promise<string | null> {
  const url = await execOk(exec, ['git', 'remote', 'get-url', 'origin'], { cwd }).catch(() => '')
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
  token: string | null,
  env: Record<string, string>,
): Promise<void> {
  const cfg = join(teaXdgHome(token), 'tea', 'config.yml')
  if (existsSync(cfg)) return
  const url = process.env.GITEA_SERVER_URL ?? (await remoteBaseUrl(exec, cwd))
  if (token === null || url === null) return
  await execOk(
    exec,
    [
      'tea',
      'logins',
      'add',
      '--name',
      TEA_LOGIN,
      '--url',
      url,
      '--token',
      token,
      '--no-version-check',
    ],
    { cwd, env },
  )
}

/** Env for a tea subprocess: Amagi's XDG_CONFIG_HOME with a login provisioned from the token. */
export async function teaEnv(
  exec: Exec = defaultExec,
  cwd: string,
): Promise<Record<string, string>> {
  const token = forgeToken('forgejo', cwd)
  const env: Record<string, string> = { XDG_CONFIG_HOME: teaXdgHome(token) }
  await ensureTeaLogin(exec, cwd, token, env)
  return env
}
