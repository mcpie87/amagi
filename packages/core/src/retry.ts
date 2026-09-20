/**
 * Harness failures split into two buckets. Transient ones (quota, rate limit,
 * overloaded model, flaky network) are worth re-running after a backoff;
 * everything else is operator-actionable and escalates immediately.
 */
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
] as const

export function isTransientFailure(detail: string): boolean {
  const text = detail.toLowerCase()
  return TRANSIENT_PATTERNS.some((re) => re.test(text))
}

/** Exponential backoff for a 1-based attempt, capped at maxMs. */
export function backoffDelayMs(baseMs: number, maxMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs)
}
