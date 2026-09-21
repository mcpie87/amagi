import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import { implementSystemPrompt, prTitle } from './prompt.ts'

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

describe('implementSystemPrompt', () => {
  test('tells the agent to document how to use new user-facing features', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('user-facing feature')
    expect(prompt).toContain('### How to use')
    expect(prompt).toContain('description in the issue tracker')
  })
})
