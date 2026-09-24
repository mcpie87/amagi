import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import {
  classifyMentionPrompt,
  commitMessage,
  implementPrompt,
  implementSystemPrompt,
  prFailurePrompt,
  prFailureSystemPrompt,
  prTitle,
} from './prompt.ts'

const TASK: TrackerTask = {
  id: 'am-1',
  title: 'Add a greeting file',
  description: 'Write hello.txt',
  status: 'in_progress',
  priority: 1,
  type: 'task',
  url: null,
}

describe('commitMessage', () => {
  test('renders the title, task and a bullet-point summary of changes', () => {
    const message = commitMessage(TASK, [
      { path: 'hello.txt', additions: 1, deletions: 0 },
      { path: 'image.png', additions: Number.NaN, deletions: Number.NaN },
    ])

    expect(message).toBe(
      'Add a greeting file\n\nTask: am-1\n\nChanges:\n- `hello.txt` +1 -0\n- `image.png` binary\n',
    )
  })

  test('omits the changes section when nothing changed', () => {
    const message = commitMessage(TASK)
    expect(message).toBe('Add a greeting file\n\nTask: am-1\n')
  })
})

const task = (title: string): TrackerTask => ({
  id: 'am-544',
  title,
  description: '',
  status: 'in_progress',
  priority: null,
  type: 'task',
  url: null,
})

describe('prFailurePrompt', () => {
  test('asks for a read-only diagnosis and operator instructions', () => {
    const prompt = prFailurePrompt(TASK, 'amagi/am-1-change', 'gh not authenticated')
    expect(prompt).toContain('gh not authenticated')
    expect(prompt).toContain('exactly what the operator must do')
    expect(prompt).toContain('Do not modify files, git state, branches, remotes, or forge state')
    expect(prompt).not.toContain('fix what it can')
  })

  test('sets strict read-only investigation rules', () => {
    const prompt = prFailureSystemPrompt()
    expect(prompt).toContain('strictly read-only')
    expect(prompt).toContain('Do not run writing git commands')
    expect(prompt).toContain('Do not modify remotes')
  })
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
    expect(prompt).toContain('final message')
  })

  test('tells the agent not to pipe check or lint output through head/tail', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('Never pipe check or lint output through head/tail')
    expect(prompt).toContain('Redirect to a file instead')
  })

  test('keeps the agent off bd: the issue text is embedded and sections are written back', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('Never edit issues with the tracker CLI (bd)')
    expect(prompt).toContain('embedded in the')
    expect(prompt).toContain('writes the sections')
  })

  test('names the gate commands so the agent need not discover them', () => {
    const prompt = implementSystemPrompt({
      task: task('Add a flag'),
      worktree: '/wt',
      branch: 'b',
      checks: ['just fmt', 'just lint', 'just check'],
    })
    expect(prompt).toContain('`just fmt`, `just lint`, `just check`')
    expect(prompt).not.toContain('e.g. `just fmt`')
  })

  test('a clean tree is not a valid outcome for investigation-style tasks', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('investigation-style tasks')
    expect(prompt).toContain('clean working tree is not a valid outcome')
  })

  test('asks for a mandatory conclusion in the final message, written against the real diff', () => {
    const prompt = implementSystemPrompt({ task: task('Add a flag'), worktree: '/wt', branch: 'b' })
    expect(prompt).toContain('### Conclusion')
    expect(prompt).toContain('git diff --stat <base>')
    expect(prompt).toContain('file by file')
    expect(prompt).toContain('mandatory')
    expect(prompt).toContain('deviations from')
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

describe('classifyMentionPrompt', () => {
  test('maps questions about a change still being relevant to explain, not ambiguous', () => {
    const prompt = classifyMentionPrompt({
      pr: { number: 102, title: 'Revert PR #36', url: 'https://github.com/owner/repo/pull/102' },
      mention: { user: 'mcpie87', body: '@chise-maru is this change still relevant?' },
    })
    expect(prompt).toContain('explain: the human is asking anything about the PR')
    expect(prompt).toContain('still relevant')
    expect(prompt).toContain('never ambiguous')
  })
})
