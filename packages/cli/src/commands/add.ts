import { errMsg, type RegistryEntry, Workspaces } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red } from '../format.ts'

export const addCommand = defineCommand({
  meta: { name: 'add', description: 'Register a repository with the workspace' },
  args: {
    path: {
      type: 'positional',
      description: 'Path to a directory inside the repository',
      required: true,
    },
    key: {
      type: 'string',
      description: 'Registry key, defaulting to the repo directory name',
      default: '',
    },
  },
  async run({ args }) {
    const workspaces = new Workspaces()
    let entry: RegistryEntry
    try {
      entry = workspaces.add(args.path, args.key || undefined)
    } catch (err) {
      console.log(red(`failed to register ${args.path}: ${errMsg(err)}`))
      process.exitCode = 1
      return
    }
    const ready = await workspaces.diagnose(entry)
    console.log(`${green('registered')} ${bold(entry.key)}  ${entry.path}`)
    for (const d of ready) {
      console.log(
        `  ${d.ok ? green('ok') : red('!!')}  ${d.name}${d.detail === undefined ? '' : dim(`  ${d.detail}`)}`,
      )
    }
    const ok = ready.every((d) => d.ok)
    if (!ok) console.log(dim('\nfix the flagged items and re-check with: amagi repos'))
  },
})
