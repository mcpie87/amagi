import { loadConfig, repoRoot, Store } from '@amagi/core'
import { defineCommand } from 'citty'
import { answerQuestion } from '../ask.ts'

export const answerCommand = defineCommand({
  meta: { name: 'answer', description: 'Answer an open question on behalf of a task' },
  args: {
    id: { type: 'positional', description: 'The question id', required: true },
    answer: { type: 'positional', description: 'The answer text', required: true },
  },
  async run({ args }) {
    const { config } = loadConfig(repoRoot())
    const store = new Store()
    const question = store.question(args.id)
    if (!question) throw new Error(`unknown question ${args.id}`)
    const token = store.token(question.taskId)
    store.close()

    const resolved = await answerQuestion({
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      questionId: args.id,
      taskId: question.taskId,
      token,
      answer: args.answer,
    })
    console.log(`answered ${resolved.id} (${question.taskId}): ${resolved.answer}`)
  },
})
