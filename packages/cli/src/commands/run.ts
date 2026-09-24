import {
  dropLiveRun,
  isTerminal,
  listModelsCached,
  loadConfig,
  makeHarness,
  makeTracker,
  Runner,
  recordLiveRun,
  repoName,
  repoRoot,
  updateLiveRun,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, printBlock, red, yellow } from '../format.ts'
import { interactive, picker } from '../picker.ts'
import { currentRepo } from '../repo.ts'
import { pickRunSelection, type RunSelection, usageCounts } from '../select-run.ts'

const listModelsFor = (cfg: Parameters<typeof makeHarness>[0]) => {
  const harness = makeHarness(cfg)
  return listModelsCached(harness.kind, () => harness.listModels())
}

/**
 * Drives one task to its milestone: claims the next ready task (or the named
 * one for `continue`), runs it with the picked harness/model, and prints the
 * live event feed. Shared by `amagi run` and `amagi continue`.
 */
export async function workOneTask(opts: {
  root: string
  taskId?: string
  flags: { harness?: string; model?: string; effort?: string }
}): Promise<void> {
  const { root, taskId } = opts
  const { config } = loadConfig(root)
  const { key, name, store } = currentRepo()
  const selection: RunSelection = await pickRunSelection(
    config,
    opts.flags,
    interactive() ? picker : null,
    listModelsFor,
    usageCounts(store.events()),
  )

  const implement = selection.harness
  const matchingWorkers = config.worker.filter((candidate) => {
    const fallback =
      candidate.kind === config.harness.implement.kind ? config.harness.implement : null
    return (
      candidate.kind === implement.kind &&
      (candidate.model ?? fallback?.model ?? null) === (implement.model ?? null) &&
      (candidate.effort ?? fallback?.effort ?? null) === (implement.effort ?? null) &&
      (candidate.seat ?? candidate.kind) === (implement.seat ?? implement.kind)
    )
  })
  const worker = matchingWorkers.length === 1 ? matchingWorkers[0] : undefined
  if (selection.interactive) {
    const bits = [
      implement.model ? `model ${implement.model}` : null,
      implement.effort ? `effort ${implement.effort}` : null,
    ].filter(Boolean)
    console.log(dim(`harness: ${implement.kind}${bits.length > 0 ? ` (${bits.join(', ')})` : ''}`))
  }

  const runner = new Runner({
    store,
    tracker: makeTracker(config, root),
    harness: makeHarness(implement),
    config: { ...config, harness: { ...config.harness, implement } },
    repoRoot: root,
    repoName: repoName(root),
  })

  // The task is claimed inside runner.runOnce, so the worker's identity is only
  // known once the claim event lands. Record it then so the dashboard Workers
  // section shows this foreground run; drop it in the finally below.
  let liveTaskId: string | null = null
  const recordLive = (claimedTaskId: string, title: string) => {
    liveTaskId = claimedTaskId
    recordLiveRun({
      pid: process.pid,
      repoKey: key,
      repoName: name,
      taskId: claimedTaskId,
      title,
      harness: implement.kind,
      model: implement.model ?? null,
      effort: implement.effort ?? null,
      workerId: worker?.id ?? null,
      workerName: worker?.name ?? null,
      seat: worker?.seat ?? implement.seat ?? implement.kind,
      waitingOnSeat: false,
      startedAt: Date.now(),
    })
  }

  const unsubscribe = store.subscribe((event) => {
    switch (event.type) {
      case 'task.claimed': {
        if (event.taskId !== null) recordLive(event.taskId, event.title)
        console.log(`\n${bold(event.taskId ?? '')}  ${event.title}`)
        const details = [
          event.priority === null || event.priority === undefined ? null : `P${event.priority}`,
          event.taskType,
          event.difficulty,
        ].filter(Boolean)
        if (details.length > 0) console.log(dim(`  ${details.join('  ')}`))
        if (event.url) console.log(dim(`  ${event.url}`))
        if (event.description?.trim()) printBlock(event.description)
        break
      }
      case 'claim.rejected':
        console.log(
          yellow(
            `  skipped ${event.title}${event.difficulty ? ` (${event.difficulty})` : ''}: ${event.reason}`,
          ),
        )
        break
      case 'task.state':
        console.log(dim(`  -> ${event.to}${event.reason ? `: ${event.reason}` : ''}`))
        break
      case 'worktree.created':
        console.log(dim(`  worktree: ${event.path} (${event.branch})`))
        break
      case 'agent.started':
        if (liveTaskId !== null) updateLiveRun(key, liveTaskId, { waitingOnSeat: false })
        console.log(dim(`  agent: ${event.harness}${event.model ? ` (${event.model})` : ''}`))
        break
      case 'agent.stream':
        if (event.event.kind === 'status' && liveTaskId !== null) {
          updateLiveRun(key, liveTaskId, {
            waitingOnSeat: event.event.message.startsWith('waiting for seat '),
          })
        }
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
    if (taskId === undefined) console.log(dim(`claiming next ready task in ${key}...`))
    const result = await runner.runOnce(taskId)
    if (result === null) {
      console.log(dim(taskId === undefined ? 'nothing ready to work on' : `unknown task ${taskId}`))
      return
    }

    const { task, state } = result
    const needsHuman = state === 'needs_human' || state === 'no_pr'
    const paint = needsHuman ? red : isTerminal(state) ? green : yellow
    console.log(`\n${bold(task.id)}  ${paint(state)}  ${task.title}`)
    if (needsHuman) process.exitCode = 1
  } finally {
    unsubscribe()
    if (liveTaskId !== null) dropLiveRun(key, liveTaskId)
    store.close()
  }
}

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Claim the next ready task and work it in its own worktree' },
  args: {
    once: { type: 'boolean', description: 'Work a single task and exit', default: true },
    harness: {
      type: 'string',
      description: 'Harness kind to use (claude/codex/opencode)',
    },
    model: { type: 'string', description: 'Model to pass to the harness' },
    effort: { type: 'string', description: 'Reasoning effort to pass to the harness' },
  },
  async run({ args }) {
    await workOneTask({
      root: repoRoot(),
      flags: { harness: args.harness, model: args.model, effort: args.effort },
    })
  },
})
