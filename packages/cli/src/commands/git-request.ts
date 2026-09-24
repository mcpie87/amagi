import { git, loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { requestGitWrite, taskIdFromBranch } from '../git-request.ts'

export const gitRequestCommand = defineCommand({
  meta: {
    name: 'git-request',
    description: 'Request a sanctioned git write from the orchestrator',
  },
  args: {
    verb: { type: 'positional', description: 'The git write to request', required: true },
    task: {
      type: 'string',
      description: 'Task id, defaulting to the worktree branch',
      default: '',
    },
  },
  async run({ args }) {
    // The runner never parses prose: only the closed set is accepted, and the
    // verb is validated here so the server is not even asked about the rest.
    if (args.verb !== 'commit') throw new Error(`amagi git-request: unknown verb ${args.verb}`)
    const token = process.env.AMAGI_TASK_TOKEN
    if (!token) throw new Error('AMAGI_TASK_TOKEN is not set; run this inside an amagi worktree')
    const { config } = loadConfig(repoRoot())
    const taskId = args.task || taskIdFromBranch(git(['rev-parse', '--abbrev-ref', 'HEAD']))
    if (!taskId) throw new Error('could not read the task id from the worktree branch')

    const sha = await requestGitWrite({
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      taskId,
      token,
      verb: args.verb,
    })
    console.log(sha)
  },
})
