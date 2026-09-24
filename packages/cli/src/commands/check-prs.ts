import {
  type Config,
  isConflicting,
  loadConfig,
  makePrDriver,
  makeTracker,
  type PrDriver,
  type PrInfo,
  type PrPriority,
  repoName,
  repoRoot,
  resolveConflict,
  resolvePrPriorities,
  syncPrPriorityLabel,
  taskIdFromAmagiBranch,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red, table, yellow } from '../format.ts'
import { currentRepo } from '../repo.ts'

function mergeLabel(p: PrInfo, baseBranch: string): string {
  if (isConflicting(p, baseBranch)) return 'CONFLICT'
  if (p.mergeable === 'UNKNOWN' || p.mergeStateStatus === 'UNKNOWN') return 'UNKNOWN'
  return 'CLEAN'
}

/** A bulk PR list reports UNKNOWN until the forge computes mergeability; resolve per-PR. */
async function resolveMergeStatuses(
  root: string,
  prs: PrInfo[],
  driver: PrDriver,
): Promise<PrInfo[]> {
  return Promise.all(
    prs.map(async (p) => {
      if (p.mergeable !== 'UNKNOWN' && p.mergeStateStatus !== 'UNKNOWN') return p
      const status = await driver.getMergeStatus(root, p.number)
      const mergeable =
        status === 'conflicted' ? 'CONFLICTING' : status === 'mergeable' ? 'MERGEABLE' : 'UNKNOWN'
      const mergeStateStatus =
        status === 'conflicted' ? 'DIRTY' : status === 'mergeable' ? 'CLEAN' : 'UNKNOWN'
      return { ...p, mergeable, mergeStateStatus }
    }),
  )
}

async function resolveOne(
  pr: PrInfo,
  root: string,
  config: Config,
  driver: PrDriver,
  tracker: import('@amagi/core').Tracker,
  store: import('@amagi/core').Store,
): Promise<void> {
  console.log(`\n${bold(`#${pr.number}`)}  ${pr.title}`)
  console.log(dim(`  ${pr.url}`))
  try {
    const result = await resolveConflict({
      repoRoot: root,
      repoName: repoName(root),
      pr,
      config,
      driver,
      store,
      onLog: (level, text) =>
        console.log(level === 'error' || level === 'warn' ? red(`  ${text}`) : dim(`  ${text}`)),
    })
    const taskId = taskIdFromAmagiBranch(pr.headRefName)
    if (taskId !== null && result.iteration > 0) {
      try {
        await tracker.setMetadata?.(taskId, { iterations: String(result.iteration) })
      } catch (err) {
        console.log(
          red(`  iteration metadata failed: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    }
    console.log(result.ok ? green(`  ${result.message}`) : red(`  ${result.message}`))
  } catch (err) {
    console.log(red(`  ${err instanceof Error ? err.message : String(err)}`))
  }
}

export const checkPrsCommand = defineCommand({
  meta: {
    name: 'check-prs',
    description:
      'List open PRs and dispatch an agent to resolve any conflicts against the base branch',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Only list PRs and conflicts; do not dispatch agents',
      default: false,
    },
  },
  async run({ args }) {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const driver = makePrDriver(config.forge.kind)

    let prs: PrInfo[]
    try {
      prs = await driver.listOpenPrs(root)
    } catch (err) {
      console.log(
        red(
          `failed to list PRs: ${err instanceof Error ? err.message : String(err)} (is the forge CLI installed and authenticated?)`,
        ),
      )
      return
    }
    if (prs.length === 0) {
      console.log(dim('no open pull requests'))
      return
    }

    const base = config.repo.baseBranch
    const resolved = await resolveMergeStatuses(root, prs, driver)
    const tracker = makeTracker(config, root)
    const priorities = await resolvePrPriorities(resolved, (id) => tracker.get(id))
    const ordered = resolved
      .map((pr, i) => ({ pr, pri: priorities[i] }))
      .filter((x): x is { pr: PrInfo; pri: PrPriority } => x.pri !== undefined)
      .sort((a, b) => a.pri.priority - b.pri.priority || a.pr.number - b.pr.number)
    const header = ['PR', 'MERGE', 'PRIORITY', 'BASE', 'HEAD', 'TITLE']
    const rows = ordered.map(({ pr, pri }) => [
      `#${pr.number}`,
      mergeLabel(pr, base),
      `P${pri.priority}`,
      pr.baseRefName,
      pr.headRefName,
      pr.title,
    ])
    console.log(
      table([header, ...rows], (row, i) => {
        if (i === 0) return row.map(bold)
        const paint = row[1] === 'CONFLICT' ? red : row[1] === 'UNKNOWN' ? yellow : green
        return row.map((c, j) => (j === 1 ? paint(c) : c))
      }),
    )

    if (!args['dry-run']) {
      for (const { pr, pri } of ordered) {
        if (!pri.amagi) continue
        await syncPrPriorityLabel({
          cwd: root,
          number: pr.number,
          labels: pr.labels,
          // A PR whose bead is gone or closed carries no priority label.
          priority: pri.linked ? pri.priority : null,
        })
      }
    }

    const conflicts = ordered.filter(({ pr }) => isConflicting(pr, base))
    if (conflicts.length === 0) {
      console.log(dim('\nno merge conflicts'))
      return
    }
    if (args['dry-run']) {
      console.log(
        dim(`\n${conflicts.length} conflicting; re-run without --dry-run to dispatch agents`),
      )
      return
    }

    console.log(
      `\n${yellow(`${conflicts.length} conflicting PR(s), dispatching resolution agents:`)}`,
    )
    const store = currentRepo().store
    for (const { pr } of conflicts) {
      await resolveOne(pr, root, config, driver, tracker, store)
    }
  },
})
