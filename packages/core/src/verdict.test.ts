import { describe, expect, test } from 'bun:test'
import { parseVerdict, VERDICTS, verdictPromptLines, withVerdictLine } from './verdict.ts'

describe('parseVerdict', () => {
  test('reads a plain verdict line anywhere in the summary', () => {
    expect(parseVerdict('Nothing to do.\n\nVerdict: close-task\n\nmore')).toBe('close-task')
  })

  test('tolerates markdown decoration and casing', () => {
    expect(parseVerdict('**Verdict:** `Postpone`.')).toBe('postpone')
    expect(parseVerdict('- verdict: new-tasks')).toBe('new-tasks')
  })

  test('an unknown label or a missing line is null', () => {
    expect(parseVerdict('Verdict: ship-it')).toBeNull()
    expect(parseVerdict('the verdict: close-task is implied')).toBeNull()
    expect(parseVerdict(null)).toBeNull()
  })

  test('every label the prompt shows parses back', () => {
    const prompt = verdictPromptLines().join('\n')
    for (const { label } of VERDICTS) {
      expect(prompt).toContain(`\`${label}\``)
      expect(parseVerdict(`Verdict: ${label}`)).toBe(label)
    }
  })
})

describe('withVerdictLine', () => {
  test('moves the verdict line to the top', () => {
    expect(withVerdictLine('Already on main.\n\nVerdict: close-task')).toBe(
      'Verdict: close-task\n\nAlready on main.',
    )
  })

  test('a summary without a verdict gets the fallback', () => {
    expect(withVerdictLine('I am not sure.')).toBe('Verdict: needs-human\n\nI am not sure.')
    expect(withVerdictLine('dup', 'close-task')).toBe('Verdict: close-task\n\ndup')
  })
})
