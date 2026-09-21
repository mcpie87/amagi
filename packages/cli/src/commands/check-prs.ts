import {
  type Config,
  isConflicting,
  listOpenPrs,
  loadConfig,
  makeTracker,
  type PrInfo,
  type PrPriority,
  prMergeStatus,
  repoName,
  repoRoot,
  resolveConflict,
  resolvePrPriorities,
  syncPrPriorityLabel,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, printBlock, red, table, yellow } from '../format.ts'

function mergeLabel(p: PrInfo, baseBranch: string): string {
  if (isConflicting(p, baseBranch)) return 'CONFLICT'
  if (p.mergeable === 'UNKNOWN' || p.mergeStateStatus === 'UNKNOWN') return 'UNKNOWN'
  return 'CLEAN'
}

/** gh pr list reports UNKNOWN until GitHub computes mergeability; resolve per-PR. */
async function resolveMergeStatuses(root: string, prs: PrInfo[]): Promise<PrInfo[]> {
  return Promise.all(
    prs.map(async (p) => {
      if (p.mergeable !== 'UNKNOWN' && p.mergeStateStatus !== 'UNKNOWN') return p
      return { ...p, ...(await prMergeStatus(root, p.number)) }
    }),
  )
}

async function resolveOne(pr: PrInfo, root: string, config: Config): Promise<void> {
  console.log(`\n${bold(`#${pr.number}`)}  ${pr.title}`)
  console.log(dim(`  ${pr.url}`))
  const { ok, message } = await resolveConflict({
    repoRoot: root,
    repoName: repoName(root),
    pr,
    config,
    onLog(level, text) {
      if (level === 'agent') printBlock(text)
      else if (level === 'error') console.log(red(`  ${text}`))
      else if (level === 'ok') console.log(green(`  ${text}`))
      else if (level === 'warn') console.log(yellow(`  ${text}`))
      else console.log(dim(`  ${text}`))
    },
  })
  if (!ok) console.log(red(`  ${message}`))
}

export const checkPrsCommand = defineCommand({
  meta: {
    name: 'check-prs',
    description:
      'List GitHub PRs and dispatch an agent to resolve any conflicts against the base branch',
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

    let prs: PrInfo[]
    try {
      prs = await listOpenPrs({ cwd: root })
    } catch (err) {
      console.log(
        red(
          `failed to list PRs: ${err instanceof Error ? err.message : String(err)} (is gh installed and authenticated?)`,
        ),
      )
      return
    }
    if (prs.length === 0) {
      console.log(dim('no open pull requests'))
      return
    }

    const base = config.repo.baseBranch
    const resolved = await resolveMergeStatuses(root, prs)
    const tracker = makeTracker(config, root)
    const priorities = await resolvePrPriorities(resolved, (id) => tracker.get(id))
    // Priority is the first sort key of the dispatch order; P0 first, oldest PR first within a band.
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
    for (const { pr } of conflicts) {
      await resolveOne(pr, root, config)
    }
  },
})
