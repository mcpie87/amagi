import { loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { answerQuestion } from '../answer.ts'
import { green } from '../format.ts'
import { currentRepo } from '../repo.ts'

export const answerCommand = defineCommand({
  meta: { name: 'answer', description: 'Answer a waiting question' },
  args: {
    id: { type: 'positional', description: 'Question id', required: true },
    answer: { type: 'positional', description: 'Your answer', required: true },
  },
  async run({ args }) {
    const { config } = loadConfig(repoRoot())
    const { key, store } = currentRepo()
    try {
      const outcome = await answerQuestion(
        `http://${config.server.host}:${config.server.port}`,
        key,
        store,
        args.id,
        args.answer,
      )
      if (outcome.kind === 'error') throw new Error(outcome.message)
      console.log(green('answered'))
    } finally {
      store.close()
    }
  },
})
