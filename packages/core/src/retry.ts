/**
 * Harness failures split into two buckets. Transient ones (quota, rate limit,
 * overloaded model, flaky network) are worth re-running after a backoff;
 * everything else is operator-actionable and escalates immediately. Within the
 * transient bucket, session-limit failures (turn, context-window or token
 * limit) are told apart: the session is spent, so the retry must start a
 * fresh session rather than resume the exhausted one.
 */
const SESSION_LIMIT_PATTERNS = [
  /\bsession limit\b/i,
  /\bturn limit\b/i,
  /\bcontext limit\b/i,
  /\bcontext window\b/i,
  /\bcontext length\b/i,
  /\btoken limit\b/i,
] as const

const TRANSIENT_PATTERNS = [
  /\bquota\b/i,
  /insufficient_quota/i,
  /resource_exhausted/i,
  /\brate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /429/,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /\btimeout\b/i,
  /timed out/i,
  /timedout/i,
  /\bnetwork\b/i,
  /\bconnection\b/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /\bthrottl/i,
  /try again later/i,
  /502|503|504/,
  /internal server error/i,
  ...SESSION_LIMIT_PATTERNS,
] as const

export function isTransientFailure(detail: string): boolean {
  const text = detail.toLowerCase()
  return TRANSIENT_PATTERNS.some((re) => re.test(text))
}

/** Whether the failure means the session is exhausted and must not be resumed. */
export function isSessionLimit(detail: string): boolean {
  const text = detail.toLowerCase()
  return SESSION_LIMIT_PATTERNS.some((re) => re.test(text))
}

/** Exponential backoff for a 1-based attempt, capped at maxMs. */
export function backoffDelayMs(baseMs: number, maxMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs)
}
