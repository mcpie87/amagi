import {
  type Config,
  isTerminal,
  listModelsCached,
  makeHarness,
  makeTracker,
  Runner,
  repoName,
  Store,
} from '@amagi/core'
import { bold, dim, green, red, yellow } from './format.ts'
import type { RunSelection } from './select-run.ts'

export const listModelsFor = async (cfg: Parameters<typeof makeHarness>[0]) => {
  const harness = makeHarness(cfg)
  return listModelsCached(harness.kind, () => harness.listModels())
}

function printBlock(text: string): void {
  for (const line of text.trim().split('\n')) console.log(`  ${line}`)
}

export type RunTaskOptions = {
  root: string
  config: Config
  selection: RunSelection
  /** When set, claims and runs this exact task instead of the next ready one. */
  taskId?: string
}

/**
 * Runs one task with the given harness/model and streams its lifecycle to the
 * console. Returns the process exit code (1 when the task needs a human).
 */
export async function runTask(opts: RunTaskOptions): Promise<number> {
  const { config, root } = opts
  const store = new Store()
  const implement = opts.selection.harness

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
          console.log(`${check.exitCode === 0 ? green('  pass') : red('  fail')}  ${check.command}`)
          if (check.exitCode !== 0 && check.output.trim()) printBlock(check.output)
        }
        if (event.results.length === 0) console.log(dim('  checks: none configured'))
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
    console.log(dim(opts.taskId === undefined ? 'claiming next ready task...' : 'running task...'))
    const result = await runner.runOnce(opts.taskId)
    if (result === null) {
      console.log(dim('nothing ready to work on'))
      return 0
    }

    const { task, state } = result
    const needsHuman = state === 'needs_human' || state === 'no_pr'
    const paint = needsHuman ? red : isTerminal(state) ? green : yellow
    console.log(`\n${bold(task.id)}  ${paint(state)}  ${task.title}`)
    return needsHuman ? 1 : 0
  } finally {
    unsubscribe()
    store.close()
  }
}
