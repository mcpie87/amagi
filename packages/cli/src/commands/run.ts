import {
  isTerminal,
  loadConfig,
  makeHarness,
  makeTracker,
  Runner,
  repoName,
  repoRoot,
  Store,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red, yellow } from '../format.ts'

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Claim the next ready task and work it in its own worktree' },
  args: {
    once: { type: 'boolean', description: 'Work a single task and exit', default: true },
  },
  async run() {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const store = new Store()

    const runner = new Runner({
      store,
      tracker: makeTracker(config, root),
      harness: makeHarness(config.harness.implement.kind),
      config,
      repoRoot: root,
      repoName: repoName(root),
    })

    const unsubscribe = store.subscribe((event) => {
      if (event.type === 'task.state') console.log(dim(`  -> ${event.to}`))
      if (event.type === 'agent.stream' && event.event.kind === 'tool_use') {
        console.log(dim(`  ${event.event.name}`))
      }
    })

    try {
      const result = await runner.runOnce()
      if (result === null) {
        console.log(dim('nothing ready to work on'))
        return
      }

      const { task, state } = result
      const paint = state === 'needs_human' ? red : isTerminal(state) ? green : yellow
      console.log(`\n${bold(task.id)}  ${paint(state)}  ${task.title}`)
      if (task.worktree) console.log(dim(`  worktree: ${task.worktree}`))
      if (task.lastError) console.log(red(`  ${task.lastError}`))
      if (state === 'needs_human') process.exitCode = 1
    } finally {
      unsubscribe()
      store.close()
    }
  },
})
