import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import { implementSystemPrompt, prFailurePrompt, prTitle } from './prompt.ts'

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

  test('tells the agent not to pipe check or lint output through head/tail', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('Never pipe check or lint output through head/tail')
    expect(prompt).toContain('Redirect to a file instead')
  })
})

describe('prFailurePrompt', () => {
  test('shows the failure and asks for a fix or a concrete explanation', () => {
    const prompt = prFailurePrompt({
      task: task('Add a flag'),
      message: 'gh not authenticated',
      branch: 'amagi/am-1-add-a-flag',
      base: 'main',
    })
    expect(prompt).toContain('Opening the pull request against main failed')
    expect(prompt).toContain('gh not authenticated')
    expect(prompt).toContain('amagi/am-1-add-a-flag')
    expect(prompt).toContain('shown verbatim to the operator')
  })
})
