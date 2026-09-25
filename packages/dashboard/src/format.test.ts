import { describe, expect, test } from 'bun:test'
import { DEFAULT_DATE_FORMAT, fmtDateTime } from './format.ts'

describe('fmtDateTime', () => {
  const date = new Date(2026, 8, 25, 14, 3, 7)

  test('uses the configured local date and 24-hour time tokens', () => {
    expect(fmtDateTime(date)).toBe('2026-09-25 14:03:07')
    expect(fmtDateTime(date, 'DD.MM.YYYY hh:mm')).toBe('25.09.2026 14:03')
  })

  test('falls back to the default for invalid templates', () => {
    expect(fmtDateTime(date, 'YYYY-MM-DD HH:mm')).toBe('2026-09-25 14:03:07')
    expect(fmtDateTime(date, '')).toBe('2026-09-25 14:03:07')
    expect(DEFAULT_DATE_FORMAT).toBe('YYYY-MM-DD hh:mm:ss')
  })
})
