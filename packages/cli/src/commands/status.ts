import { isTerminal, loadConfig, repoRoot, Store, type TaskState } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, magenta, red, relTime, table, yellow } from '../format.ts'

const STATE_COLOR: Partial<Record<TaskState, (s: string) => string>> = {
  awaiting_answer: yellow,
  needs_human: red,
  done: green,
  reviewing: magenta,
  fixing: magenta,
}

export const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show the run queue and any open questions' },
  args: {
    all: { type: 'boolean', description: 'Include finished and abandoned tasks', default: false },
    json: { type: 'boolean', description: 'Emit JSON instead of a table', default: false },
  },
  run({ args }) {
    const root = repoRoot()
    const { config, sources } = loadConfig(root)
    const store = new Store()

    const tasks = store.tasks().filter((t) => args.all || !isTerminal(t.state))
    const questions = store.openQuestions()

    if (args.json) {
      console.log(JSON.stringify({ tasks, questions, config, sources }, null, 2))
      store.close()
      return
    }

    if (tasks.length === 0) {
      console.log(dim(args.all ? 'no tasks recorded' : 'no active tasks'))
    } else {
      const header = ['TASK', 'STATE', 'ROUND', 'BRANCH', 'UPDATED', 'TITLE']
      const rows = tasks.map((t) => [
        t.id,
        t.state,
        t.reviewRound > 0 ? `r${t.reviewRound}` : '',
        t.branch ?? '',
        relTime(t.updatedAt),
        t.title,
      ])
      console.log(
        table([header, ...rows], (row, i) => {
          if (i === 0) return row.map(bold)
          const paint = STATE_COLOR[row[1] as TaskState]
          return paint ? row.map((c, j) => (j === 1 ? paint(c) : c)) : row
        }),
      )
    }

    if (questions.length > 0) {
      console.log(`\n${bold(yellow(`${questions.length} question(s) waiting on you`))}`)
      for (const q of questions) {
        const opts = q.options.length ? dim(` [${q.options.join(' | ')}]`) : ''
        console.log(`  ${q.id}  ${dim(q.taskId)}  ${q.question}${opts}`)
      }
      console.log(dim('  answer with: amagi answer <id> "<text>"'))
    }

    console.log(
      dim(
        `\ntracker=${config.tracker.kind} forge=${config.forge.kind} ` +
          `implement=${config.harness.implement.kind} review=${config.harness.review.kind} ` +
          `parallel=${config.loop.maxParallel}`,
      ),
    )
    store.close()
  },
})
