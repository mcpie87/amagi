import { Workspaces } from '@amagi/core'
import { defineCommand } from 'citty'
import { green, red } from '../format.ts'

export const removeCommand = defineCommand({
  meta: { name: 'remove', description: 'Unregister a repository from the workspace' },
  args: {
    key: { type: 'positional', description: 'Registry key', required: true },
  },
  run({ args }) {
    const workspaces = new Workspaces()
    if (!workspaces.remove(args.key)) {
      console.log(red(`unknown repository ${args.key}`))
      process.exitCode = 1
      return
    }
    console.log(green(`removed ${args.key}`))
  },
})
