import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import { prTitle } from './prompt.ts'

const task = (title: string): TrackerTask => ({
  id: 'am-544',
  title,
  description: '',
  status: 'in_progress',
  priority: null,
  type: 'task',
  url: null,
})

describe('prTitle', () => {
  test('prepends the task code to a short title', () => {
    expect(prTitle(task('Forgejo driver over tea'))).toBe('am-544: Forgejo driver over tea')
  })

  test('cuts a full sentence at the first clause', () => {
    expect(prTitle(task('PR titles should use task code, not full sentences'))).toBe(
      'am-544: PR titles should use task code',
    )
  })

  test('drops a milestone-style prefix', () => {
    expect(prTitle(task('M5: forge drivers'))).toBe('am-544: forge drivers')
  })
})
