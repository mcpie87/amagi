/**
 * Who may reach the API. The server is local, but a browser on the same
 * machine can still be pointed at it: a DNS-rebinding page arrives with its
 * own Host, and a cross-site form post cannot carry the session cookie.
 */

/** Header the CLI and TUI send with the operator secret. */
export const SESSION_HEADER = 'X-Amagi-Secret'
/** Cookie the dashboard holds; SameSite=Strict keeps it off cross-site posts. */
export const SESSION_COOKIE = 'amagi_session'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])
const WILDCARD = new Set(['', '0.0.0.0', '::'])

const bare = (host: string): string => host.replace(/^\[(.*)\]$/, '$1').toLowerCase()

/**
 * True when a Host header names loopback or the configured bind host. The port
 * is ignored so the dev dashboard on another port still passes.
 */
export function hostAllowed(hostHeader: string | undefined, configuredHost?: string): boolean {
  if (hostHeader === undefined) return false
  let hostname: string
  try {
    hostname = bare(new URL(`http://${hostHeader}`).hostname)
  } catch {
    return false
  }
  if (LOOPBACK.has(hostname)) return true
  if (configuredHost === undefined || WILDCARD.has(bare(configuredHost))) return false
  return hostname === bare(configuredHost)
}

/** Constant-time comparison, so the secret cannot be guessed byte by byte. */
export function sameSecret(presented: string, secret: string): boolean {
  const a = new TextEncoder().encode(presented)
  const b = new TextEncoder().encode(secret)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Paths whose handlers also accept the per-task token an agent carries. */
export const AGENT_ROUTE =
  /^\/api\/repos\/[^/]+\/tasks\/[^/]+\/(questions(\/[^/]+\/answer)?|git-requests)$/

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * True when a browser's Origin names the same host and port as the Host header.
 * SameSite compares sites, so a page on another port or a sibling hostname
 * still carries the session cookie; only its Origin tells it apart.
 */
export function originMatchesHost(origin: string | undefined, hostHeader: string): boolean {
  if (origin === undefined) return false
  try {
    return new URL(origin).host === new URL(`http://${hostHeader}`).host
  } catch {
    return false
  }
}
