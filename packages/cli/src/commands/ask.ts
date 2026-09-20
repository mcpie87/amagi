import { git, loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { askQuestion, listOpenQuestions, taskIdFromBranch } from '../ask.ts'

export const askCommand = defineCommand({
  meta: {
    name: 'ask',
    description: 'Ask the human a question, or list the open questions',
  },
  args: {
    question: { type: 'positional', description: 'The question to ask', default: '' },
    options: { type: 'string', description: 'Comma separated answer options', default: '' },
    task: {
      type: 'string',
      description: 'Task id, defaulting to the worktree branch',
      default: '',
    },
    list: {
      type: 'boolean',
      description: 'List open questions for fzf picking instead of asking',
      default: false,
    },
  },
  async run({ args }) {
    const { config } = loadConfig(repoRoot())
    const baseUrl = `http://${config.server.host}:${config.server.port}`

    if (args.list) {
      const questions = await listOpenQuestions(baseUrl)
      if (questions.length === 0) {
        console.log('no open questions')
        return
      }
      for (const q of questions) {
        const opts = q.options.length ? ` [${q.options.join(' | ')}]` : ''
        console.log(`${q.id}  ${q.taskId}  ${q.question}${opts}`)
      }
      return
    }

    const token = process.env.AMAGI_TASK_TOKEN
    if (!token) throw new Error('AMAGI_TASK_TOKEN is not set; run this inside an amagi worktree')
    const taskId = args.task || taskIdFromBranch(git(['rev-parse', '--abbrev-ref', 'HEAD']))
    if (!taskId) throw new Error('could not read the task id from the worktree branch')

    const outcome = await askQuestion({
      baseUrl,
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
