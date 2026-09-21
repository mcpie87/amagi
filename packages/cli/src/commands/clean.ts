import { cleanTerminalWorktrees, loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, yellow } from '../format.ts'
import { currentRepo } from '../repo.ts'

export const cleanCommand = defineCommand({
  meta: {
    name: 'clean',
    description: 'Remove worktrees and branches for terminal tasks (dry run by default)',
  },
  args: {
    apply: {
      type: 'boolean',
      description: 'Remove worktrees and branches instead of only reporting them',
      default: false,
    },
  },
  async run({ args }) {
    const root = repoRoot()
    loadConfig(root)
    const { store } = currentRepo()

    const plans = await cleanTerminalWorktrees(store, { repoRoot: root, dryRun: !args.apply })

    if (plans.length === 0) {
      console.log(dim('nothing to clean'))
    } else {
      for (const p of plans) {
        const detail = p.branch ? `${p.path}  branch ${p.branch}` : p.path
        const flag = args.apply ? green('removed') : yellow('would remove')
        console.log(`${flag}  ${bold(p.taskId)}  ${dim(detail)}`)
      }
      if (!args.apply) console.log(dim('\nre-run with --apply to remove them'))
    }

    store.close()
  },
})
