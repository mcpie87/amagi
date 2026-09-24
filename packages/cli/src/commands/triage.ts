import { loadConfig, makeHarness, makeTracker, repoName, repoRoot, Triage } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, printBlock, red, yellow } from '../format.ts'
import { currentRepo } from '../repo.ts'

export const triageCommand = defineCommand({
  meta: {
    name: 'triage',
    description:
      'Pick an unclaimed task the runner skips (epics, blocked, orphaned) and decide what to do with it',
  },
  args: {
    once: { type: 'boolean', description: 'Triage a single task and exit', default: true },
    harness: {
      type: 'string',
      description: 'Harness kind to use (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
    effort: { type: 'string', description: 'Reasoning effort to pass to the harness' },
  },
  async run({ args }) {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const { key, store } = currentRepo()

    const flags = {
      ...config.harness.triage,
      ...(args.harness === undefined
        ? {}
        : { kind: args.harness as 'claude' | 'codex' | 'opencode' }),
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.effort === undefined ? {} : { effort: args.effort }),
    }

    const triage = new Triage({
      store,
      tracker: makeTracker(config, root),
      harness: makeHarness(flags),
      config,
      repoRoot: root,
      repoName: repoName(root),
    })

    const unsubscribe = store.subscribe((event) => {
      switch (event.type) {
        case 'task.claimed': {
          console.log(`\n${bold(event.taskId ?? '')}  ${event.title}`)
          if (event.description?.trim()) printBlock(event.description)
          break
        }
        case 'task.state':
          console.log(dim(`  -> ${event.to}${event.reason ? `: ${event.reason}` : ''}`))
          break
        case 'agent.started':
          console.log(
            dim(`  triage agent: ${event.harness}${event.model ? ` (${event.model})` : ''}`),
          )
          break
        case 'agent.stream':
          if (event.event.kind === 'tool_use') console.log(dim(`  ${event.event.name}`))
          if (event.event.kind === 'text' && event.event.text.trim()) {
            printBlock(event.event.text)
          }
          break
        case 'triage.decision':
          console.log(
            `${bold(event.action)}  ${event.reason}${
              event.question ? `\n  question: ${event.question}` : ''
            }`,
          )
          break
        case 'question.asked':
          console.log(`\n${bold(yellow('  AWAITING YOUR ANSWER'))}`)
          printBlock(yellow(event.question))
          if (event.options.length > 0) printBlock(dim(`options: ${event.options.join(' | ')}`))
          break
        case 'pr.created':
          console.log(green(`  pull request: ${event.url}`))
          break
        case 'error':
          console.log(red(`  ${event.message}`))
          break
      }
    })

    try {
      console.log(dim(`triaging unclaimed tasks in ${key}...`))
      const result = await triage.triageOnce()
      if (result === null) {
        console.log(dim('nothing unclaimed to triage'))
        return
      }
      const { task, action, result: detail } = result
      console.log(`\n${bold(task.id)}  ${yellow(action)}  ${task.title}`)
      if (detail.trim() !== '') printBlock(detail)
    } finally {
      unsubscribe()
      store.close()
    }
  },
})
