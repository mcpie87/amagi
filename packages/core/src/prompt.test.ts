import { describe, expect, test } from 'bun:test'
import type { TrackerTask } from './drivers/types.ts'
import { commitMessage } from './prompt.ts'

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
