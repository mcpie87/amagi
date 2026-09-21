import { git, loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { askQuestion, taskIdFromBranch } from '../ask.ts'
import { currentRepo } from '../repo.ts'

export const askCommand = defineCommand({
  meta: { name: 'ask', description: 'Ask the human a question and block for the answer' },
  args: {
    question: { type: 'positional', description: 'The question to ask', required: true },
    options: { type: 'string', description: 'Comma separated answer options', default: '' },
    task: {
      type: 'string',
      description: 'Task id, defaulting to the worktree branch',
      default: '',
    },
  },
  async run({ args }) {
    const token = process.env.AMAGI_TASK_TOKEN
    if (!token) throw new Error('AMAGI_TASK_TOKEN is not set; run this inside an amagi worktree')
    const { config } = loadConfig(repoRoot())
    const { key } = currentRepo()
    const taskId = args.task || taskIdFromBranch(git(['rev-parse', '--abbrev-ref', 'HEAD']))
    if (!taskId) throw new Error('could not read the task id from the worktree branch')

    const outcome = await askQuestion({
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      repo: key,
      taskId,
      token,
      question: args.question,
      options: args.options
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      deadlineMs: config.loop.questionTimeoutSec * 1000,
    })

    if (outcome.kind === 'answered') console.log(outcome.answer)
    else console.log('NO_ANSWER_YET')
  },
})
