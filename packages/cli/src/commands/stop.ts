import { isTerminal } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, green, red } from '../format.ts'
import { currentRepo } from '../repo.ts'

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description:
      'Interrupt a running task: park it in cancelled so the runner kills its agent process',
  },
  args: {
    task: { type: 'positional', description: 'Task id to stop', required: true },
  },
  async run({ args }) {
    const { store } = currentRepo()
    try {
      const task = store.task(args.task)
      if (task === null) throw new Error(`unknown task ${args.task}`)
      if (isTerminal(task.state)) {
        throw new Error(`task ${args.task} is already in terminal state ${task.state}`)
      }
      store.append(args.task, {
        type: 'task.state',
        from: task.state,
        to: 'cancelled',
        reason: 'operator interrupt',
      })
      console.log(
        `${bold(args.task)}  ${red('cancelled')}  ${green('running agent will be stopped')}`,
      )
    } finally {
      store.close()
    }
  },
})
