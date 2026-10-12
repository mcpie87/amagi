import { git, loadGlobalConfig } from '@amagi/core'
import { defineCommand } from 'citty'
import {
  GIT_REQUEST_VERBS,
  isGitRequestVerb,
  requestGitWrite,
  taskIdFromBranch,
} from '../git-request.ts'
import { currentRepo } from '../repo.ts'

export const gitRequestCommand = defineCommand({
  meta: {
    name: 'git-request',
    description: 'Request a sanctioned git write from the orchestrator',
  },
  args: {
    verb: {
      type: 'positional',
      description: `The git write to request: ${GIT_REQUEST_VERBS.join(', ')}`,
      required: true,
    },
    message: {
      type: 'string',
      description: 'Commit body, comment text or close reason',
    },
    task: {
      type: 'string',
      description: 'Task id, defaulting to the worktree branch',
      default: '',
    },
  },
  async run({ args }) {
    // The runner never parses prose: only the closed set is accepted, and the
    // verb is validated here so the server is not even asked about the rest.
    const verb = args.verb
    if (!isGitRequestVerb(verb)) throw new Error(`amagi git-request: unknown verb ${verb}`)
    const token = process.env.AMAGI_TASK_TOKEN
    if (!token) throw new Error('AMAGI_TASK_TOKEN is not set; run this inside an amagi worktree')
    const config = loadGlobalConfig()
    const { key } = currentRepo()
    const taskId = args.task || taskIdFromBranch(git(['rev-parse', '--abbrev-ref', 'HEAD']))
    if (!taskId) throw new Error('could not read the task id from the worktree branch')

    const result = await requestGitWrite({
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      repo: key,
      taskId,
      token,
      verb,
      ...(args.message === undefined ? {} : { message: args.message }),
    })
    console.log(result)
  },
})
