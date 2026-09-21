import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import { implementPrompt, implementSystemPrompt, prTitle } from './prompt.ts'

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

  test('tells the agent bd is unavailable in the worktree and the issue text is embedded', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('tracker CLI (bd) is unavailable inside this worktree')
    expect(prompt).toContain('embedded in the prompt')
  })

  test('a clean tree is not a valid outcome for investigation-style tasks', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('investigation-style tasks')
    expect(prompt).toContain('clean working tree is not a valid outcome')
  })
})

describe('implementPrompt', () => {
  test('embeds notes and comments so the agent sees them without bd', () => {
    const ctx = {
      task: {
        ...task('Investigate the crash'),
        notes: 'root cause: biome EPIPE panic when piped through head/tail',
        comments: ['try the fix', '  '],
      },
      worktree: '/wt',
      branch: 'b',
    }
    const prompt = implementPrompt(ctx)
    expect(prompt).toContain('Issue notes:')
    expect(prompt).toContain('root cause: biome EPIPE panic when piped through head/tail')
    expect(prompt).toContain('Issue comments:')
    expect(prompt).toContain('- try the fix')
    expect(prompt).not.toContain('-   ')
  })

  test('omits notes and comments sections when the tracker has none', () => {
    const prompt = implementPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).not.toContain('Issue notes:')
    expect(prompt).not.toContain('Issue comments:')
  })
})
