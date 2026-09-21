import {
  isTerminal,
  listModelsCached,
  loadConfig,
  makeHarness,
  makeTracker,
  Runner,
  repoName,
  repoRoot,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, printBlock, red, yellow } from '../format.ts'
import { interactive, picker } from '../picker.ts'
import { loadUsage, saveUsage } from '../picker-usage.ts'
import { currentRepo } from '../repo.ts'
import { pickRunSelection } from '../select-run.ts'

const listModelsFor = async (cfg: Parameters<typeof makeHarness>[0]) => {
  const harness = makeHarness(cfg)
  return listModelsCached(harness.kind, () => harness.listModels())
}

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Claim the next ready task and work it in its own worktree' },
  args: {
    once: { type: 'boolean', description: 'Work a single task and exit', default: true },
    harness: {
      type: 'string',
      description: 'Harness to use: a harness.definitions name or a kind (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
  },
  async run({ args }) {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const { key, store } = currentRepo()

    const flags = { harness: args.harness, model: args.model }

    const usage = loadUsage()
    const selection = await pickRunSelection(
      config,
      flags,
      interactive() ? picker : null,
      listModelsFor,
      usage,
    )
    if (selection.interactive) saveUsage(usage)

    const implement = selection.harness
    if (selection.interactive) {
      console.log(
        dim(`harness: ${implement.kind}${implement.model ? ` (model ${implement.model})` : ''}`),
      )
    }

    const runner = new Runner({
      store,
      tracker: makeTracker(config, root),
      harness: makeHarness(implement),
      config: { ...config, harness: { ...config.harness, implement } },
      repoRoot: root,
      repoName: repoName(root),
    })

    const unsubscribe = store.subscribe((event) => {
      switch (event.type) {
        case 'task.claimed': {
          console.log(`\n${bold(event.taskId ?? '')}  ${event.title}`)
          const details = [
            event.priority === null || event.priority === undefined ? null : `P${event.priority}`,
            event.taskType,
          ].filter(Boolean)
          if (details.length > 0) console.log(dim(`  ${details.join('  ')}`))
          if (event.url) console.log(dim(`  ${event.url}`))
          if (event.description?.trim()) printBlock(event.description)
          break
        }
        case 'task.state':
          console.log(dim(`  -> ${event.to}${event.reason ? `: ${event.reason}` : ''}`))
          break
        case 'worktree.created':
          console.log(dim(`  worktree: ${event.path} (${event.branch})`))
          break
        case 'agent.started':
          console.log(dim(`  agent: ${event.harness}${event.model ? ` (${event.model})` : ''}`))
          break
        case 'agent.stream':
          if (event.event.kind === 'tool_use') console.log(dim(`  ${event.event.name}`))
          if (event.event.kind === 'text' && event.event.text.trim()) {
            printBlock(event.event.text)
          }
          if (event.event.kind === 'error') console.log(red(`  ${event.event.message}`))
          break
        case 'checks.finished':
          for (const check of event.results) {
            console.log(
              `${check.exitCode === 0 ? green('  pass') : red('  fail')}  ${check.command}`,
            )
            if (check.exitCode !== 0 && check.output.trim()) printBlock(check.output)
          }
          if (event.results.length === 0) console.log(dim('  checks: none configured'))
          break
        case 'question.asked': {
          console.log(`\n${bold(red('  AWAITING YOUR ANSWER'))}`)
          printBlock(yellow(event.question))
          if (event.options.length > 0) printBlock(dim(`options: ${event.options.join(' | ')}`))
          break
        }
        case 'pr.created':
          console.log(green(`  pull request: ${event.url}`))
          break
        case 'error':
          console.log(red(`  ${event.message}`))
          break
      }
    })

    try {
      console.log(dim(`claiming next ready task in ${key}...`))
      const result = await runner.runOnce()
      if (result === null) {
        console.log(dim('nothing ready to work on'))
        return
      }

      const { task, state } = result
      const needsHuman = state === 'needs_human' || state === 'no_pr'
      const paint = needsHuman ? red : isTerminal(state) ? green : yellow
      console.log(`\n${bold(task.id)}  ${paint(state)}  ${task.title}`)
      if (needsHuman) process.exitCode = 1
    } finally {
      unsubscribe()
      store.close()
    }
  },
})
