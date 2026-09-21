import { describe, expect, test } from 'bun:test'
import { backoffDelayMs, isSessionLimit, isTransientFailure } from './retry.ts'

describe('isTransientFailure', () => {
  test.each([
    ['quota exceeded', true],
    ['insufficient_quota', true],
    ['rate limit exceeded', true],
    ['HTTP 429', true],
    ['model overloaded', true],
    ['server temporarily unavailable', true],
    ['request timed out', true],
    ['connection reset by peer', true],
    ['internal server error (502)', true],
    ['hit the session limit', true],
    ['hit the turn limit', true],
    ['exceeds the maximum context length', true],
    ['model not installed', false],
    ['model unavailable', false],
    ['permission denied', false],
  ])('%s -> %s', (detail, expected) => {
    expect(isTransientFailure(detail)).toBe(expected)
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
