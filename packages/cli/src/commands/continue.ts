import { repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { workOneTask } from './run.ts'

export const continueCommand = defineCommand({
  meta: {
    name: 'continue',
    description:
      'Resume a task in its recorded worktree, optionally with a different harness or model',
  },
  args: {
    task: { type: 'positional', description: 'Task id to resume', required: true },
    harness: {
      type: 'string',
      description: 'Harness kind to use (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
  },
  async run({ args }) {
    await workOneTask({
      root: repoRoot(),
      taskId: args.task,
      flags: { harness: args.harness, model: args.model },
    })
  },
})
