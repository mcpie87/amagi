import { exec, execOk, loadConfig, makeHarness, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { type DraftTask, draftTask } from '../draft.ts'
import { bold, dim } from '../format.ts'
import { interactive, picker } from '../picker.ts'
import { listModelsFor } from '../run-task.ts'
import { pickRunSelection } from '../select-run.ts'

/** Creates the drafted task in the tracker and returns its id. */
async function createTask(root: string, draft: DraftTask): Promise<string> {
  const out = await execOk(exec, ['bd', 'create', '--title', draft.title, '--stdin', '--silent'], {
    cwd: root,
    stdin: draft.description,
  })
  const id = out.trim()
  if (id === '') throw new Error('bd create returned no task id')
  return id
}

export const newCommand = defineCommand({
  meta: {
    name: 'new',
    description: 'Interactively draft a task with the picked agent, then create it',
  },
  args: {
    harness: {
      type: 'string',
      description: 'Harness kind to use (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
  },
  async run({ args }) {
    if (!interactive()) throw new Error('amagi new needs a terminal')

    const root = repoRoot()
    const { config } = loadConfig(root)
    const flags = { harness: args.harness, model: args.model }
    const selection = await pickRunSelection(config, flags, picker, listModelsFor)
    console.log(
      dim(
        `harness: ${selection.harness.kind}${
          selection.harness.model ? ` (model ${selection.harness.model})` : ''
        }`,
      ),
    )

    const idea = await picker.input('What do you want done?')
    if (idea === null) return

    const draft = await draftTask(
      makeHarness(selection.harness),
      selection.harness,
      idea,
      picker,
      root,
    )
    console.log(dim(`draft: ${draft.title}`))

    const taskId = await createTask(root, draft)
    console.log(bold(`created ${taskId}`))
  },
})
