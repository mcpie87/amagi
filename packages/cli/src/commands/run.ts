import { loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { dim } from '../format.ts'
import { interactive, picker } from '../picker.ts'
import { listModelsFor, runTask } from '../run-task.ts'
import { pickRunSelection } from '../select-run.ts'

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Claim the next ready task and work it in its own worktree' },
  args: {
    once: { type: 'boolean', description: 'Work a single task and exit', default: true },
    harness: {
      type: 'string',
      description: 'Harness to use: a harness.definitions name or a kind (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
    effort: { type: 'string', description: 'Reasoning effort to pass to the harness' },
  },
  async run({ args }) {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const flags = { harness: args.harness, model: args.model, effort: args.effort }

    const selection = await pickRunSelection(
      config,
      flags,
      interactive() ? picker : null,
      listModelsFor,
    )
    if (selection.interactive) {
      console.log(
        dim(
          `harness: ${selection.harness.kind}${
            selection.harness.model ? ` (model ${selection.harness.model})` : ''
          }`,
        ),
      )
    }

    process.exitCode = await runTask({ root, config, selection })
  },
})
