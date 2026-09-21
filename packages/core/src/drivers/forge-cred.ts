import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { exec as defaultExec, type Exec, execOk } from '../exec.ts'
import { stateHome } from '../paths.ts'

/** The two forges Amagi can talk to; mirrors ForgeKind from config.ts. */
type ForgeKind = 'github' | 'forgejo'

/** Tea login name in the Amagi-provisioned profile; a single login per isolated config. */
export const TEA_LOGIN = 'amagi'

/**
 * Bot token for a forge, from the Amagi process environment. Never a stored
 * login: the operator exports Chise's token once when launching Amagi and gh
 * or tea is used strictly non-interactively with it.
 */
export function forgeToken(kind: ForgeKind): string | null {
  if (kind === 'github') {
    return process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null
  }
  return (
    process.env.FORGEJO_TOKEN ?? process.env.GITEA_SERVER_TOKEN ?? process.env.TEA_TOKEN ?? null
  )
}

function forgeStateDir(): string {
  return join(stateHome(), 'amagi', 'forge')
}

/** Where Amagi keeps gh's own config, so gh never reads the operator's ~/.config/gh. */
export function ghConfigDir(): string {
  return join(forgeStateDir(), 'github')
}

/** The XDG_CONFIG_HOME Amagi points tea at, so tea never reads the operator's config. */
export function teaXdgHome(): string {
  return join(forgeStateDir(), 'tea')
}

/**
 * Env for a gh subprocess: Chise's token and an Amagi-owned GH_CONFIG_DIR.
 * The config dir is set even without a token so gh fails closed instead of
 * silently falling back to whatever the operator has in ~/.config/gh.
 */
export function ghEnv(): Record<string, string> {
  const dir = ghConfigDir()
  mkdirSync(dir, { recursive: true })
  const env: Record<string, string> = { GH_CONFIG_DIR: dir }
  const token = forgeToken('github')
  if (token !== null) env.GH_TOKEN = token
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
async function ensureTeaLogin(exec: Exec, cwd: string, env: Record<string, string>): Promise<void> {
  const cfg = join(teaXdgHome(), 'tea', 'config.yml')
  if (existsSync(cfg)) return
  const token = forgeToken('forgejo')
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
  const env: Record<string, string> = { XDG_CONFIG_HOME: teaXdgHome() }
  await ensureTeaLogin(exec, cwd, env)
  return env
}
