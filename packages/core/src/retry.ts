/**
 * Harness failures split into two buckets. Transient ones (quota, rate limit,
 * overloaded model, connection reset) are worth re-running after a backoff;
 * everything else is operator-actionable and escalates immediately. Within the
 * transient bucket, session-limit failures (turn, context-window or token
 * limit) are told apart: the session is spent, so the retry must start a
 * fresh session rather than resume the exhausted one.
 *
 * Patterns anchor to error shapes (errno codes, HTTP status codes, provider
 * error identifiers) rather than bare English words, so a deterministic
 * failure whose message merely mentions a word like "connection" is not
 * retried.
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
  /\bthrottl/i,
  /\b429\b/,
  /\boverloaded\b/i,
  /\bcapacity\b/i,
  /\b5\d\d\b/,
  /internal server error/i,
  /service unavailable/i,
  /econnreset/i,
  /econnrefused/i,
  ...SESSION_LIMIT_PATTERNS,
] as const

export function isTransientFailure(detail: string): boolean {
  return TRANSIENT_PATTERNS.some((re) => re.test(detail))
}

/** Whether the failure means the session is exhausted and must not be resumed. */
export function isSessionLimit(detail: string): boolean {
  return SESSION_LIMIT_PATTERNS.some((re) => re.test(detail))
}

/** Exponential backoff for a 1-based attempt, capped at maxMs. */
export function backoffDelayMs(baseMs: number, maxMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs)
}
