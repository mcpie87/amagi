import { describe, expect, test } from 'bun:test'
import {
  backoffDelayMs,
  isSessionLimit,
  isTransientFailure,
  isUsageLimit,
  usageLimitExpiry,
} from './retry.ts'

describe('isTransientFailure', () => {
  test.each([
    ['quota exceeded', true],
    ['insufficient_quota', true],
    ['rate limit exceeded', true],
    ['RATE LIMIT EXCEEDED', true],
    ['HTTP 429', true],
    ['model overloaded', true],
    ['service unavailable', true],
    ['ECONNRESET', true],
    ['connect ECONNREFUSED', true],
    ['socket hang up', false],
    ['internal server error (502)', true],
    ['request timed out', false],
    ['connection reset by peer', false],
    ['agent network error', false],
    ['server temporarily unavailable', false],
    ['try again later', false],
    ['hit the session limit', true],
    ["You've hit your usage limit, resets at 15:40", true],
    ['hit the turn limit', true],
    ['exceeds the maximum context length', true],
    ['model not installed', false],
    ['model unavailable', false],
    ['permission denied', false],
  ])('%s -> %s', (detail, expected) => {
    expect(isTransientFailure(detail)).toBe(expected)
  })
})

describe('isUsageLimit', () => {
  test('recognizes account usage limits separately from session limits', () => {
    expect(isUsageLimit("You've hit your usage limit, resets at 15:40")).toBe(true)
    expect(isUsageLimit('hit the turn limit')).toBe(false)
  })

  test('recognizes four repeated Codex usage-limit messages', () => {
    const message = Array(4)
      .fill(
        'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:05 PM.',
      )
      .join('\n')

    expect(isUsageLimit(message)).toBe(true)
    expect(isTransientFailure(message)).toBe(true)
  })
})

describe('usageLimitExpiry', () => {
  test('parses a future reset clock in local time', () => {
    const now = new Date(2026, 8, 27, 14, 30)
    const expiry = new Date(usageLimitExpiry("You've hit your usage limit, resets at 15:40", now))
    expect(expiry.getFullYear()).toBe(now.getFullYear())
    expect(expiry.getMonth()).toBe(now.getMonth())
    expect(expiry.getDate()).toBe(now.getDate())
    expect(expiry.getHours()).toBe(15)
    expect(expiry.getMinutes()).toBe(40)
  })

  test.each([
    ['resets at 12:00 AM', 0, 23, 28],
    ['resets at 12:00 PM', 12, 10, 27],
  ])('keeps AM/PM boundary parsing for %s', (detail, hour, nowHour, day) => {
    const now = new Date(2026, 8, 27, nowHour, 0)
    const expiry = new Date(usageLimitExpiry(detail, now))

    expect(expiry.getDate()).toBe(day)
    expect(expiry.getHours()).toBe(hour)
    expect(expiry.getMinutes()).toBe(0)
  })

  test('parses a Codex try-again clock in local time', () => {
    const now = new Date(2026, 8, 27, 14, 30)
    const detail =
      'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:05 PM.'
    const expiry = new Date(usageLimitExpiry(detail, now))

    expect(expiry.getFullYear()).toBe(now.getFullYear())
    expect(expiry.getMonth()).toBe(now.getMonth())
    expect(expiry.getDate()).toBe(now.getDate())
    expect(expiry.getHours()).toBe(23)
    expect(expiry.getMinutes()).toBe(5)
  })

  test('rolls a passed Codex try-again clock to the next day', () => {
    const now = new Date(2026, 8, 27, 23, 6)
    const expiry = new Date(usageLimitExpiry('try again at 11:05 PM', now))

    expect(expiry.getDate()).toBe(28)
    expect(expiry.getHours()).toBe(23)
    expect(expiry.getMinutes()).toBe(5)
  })

  test('uses a bounded window when no reset is reported', () => {
    const now = new Date(2026, 8, 27, 14, 30)
    expect(usageLimitExpiry('usage limit reached', now) - now.getTime()).toBe(15 * 60 * 1000)
  })

  test('uses a bounded window when the reported clock is invalid', () => {
    const now = new Date(2026, 8, 27, 14, 30)
    expect(usageLimitExpiry('try again at 11:65 PM', now) - now.getTime()).toBe(15 * 60 * 1000)
  })
})

describe('isSessionLimit', () => {
  test.each([
    ['hit the session limit', true],
    ['hit the turn limit', true],
    ['context window too long', true],
    ['exceeds the maximum context length', true],
    ['rate limit exceeded', false],
    ['model not installed', false],
  ])('%s -> %s', (detail, expected) => {
    expect(isSessionLimit(detail)).toBe(expected)
  })
})

describe('backoffDelayMs', () => {
  test('doubles per attempt and caps at maxMs', () => {
    expect(backoffDelayMs(1000, 100_000, 1)).toBe(1000)
    expect(backoffDelayMs(1000, 100_000, 2)).toBe(2000)
    expect(backoffDelayMs(1000, 100_000, 3)).toBe(4000)
    expect(backoffDelayMs(1000, 3000, 5)).toBe(3000)
  })
})
