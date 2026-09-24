import {
  type Config,
  harnessStartOpts,
  isConflicting,
  loadConfig,
  makeHarness,
  makePrDriver,
  makeTracker,
  type PrDriver,
  type PrInfo,
  prepareConflictWorktree,
  pushConflictFix,
  repoName,
  repoRoot,
  resolveConflictPrompt,
  resolveConflictSystemPrompt,
  stampIterationLabel,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, printBlock, red, table, yellow } from '../format.ts'

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
): Promise<void> {
  console.log(`\n${bold(`#${pr.number}`)}  ${pr.title}`)
  console.log(dim(`  ${pr.url}`))
  try {
    const wt = await prepareConflictWorktree({
      repoRoot: root,
      repoName: repoName(root),
      worktreeRoot: config.repo.worktreeRoot,
      baseBranch: config.repo.baseBranch,
      pr,
      persona: config.repo.persona,
    })
    console.log(dim(`  worktree: ${wt.path}`))

    if (!wt.conflicted) {
      await pushConflictFix({
        cwd: wt.path,
        branch: wt.branch,
        headRef: pr.headRefName,
        remote: config.forge.remote,
      })
      console.log(green('  base merges cleanly; pushed the merge to update the PR'))
      return
    }

    const ctx = {
      pr,
      worktree: wt.path,
      branch: wt.branch,
      baseBranch: config.repo.baseBranch,
      checks: config.checks.commands,
    }
    const harness = makeHarness(config.harness.implement)
    const proc = harness.start({
      cwd: wt.path,
      prompt: resolveConflictPrompt(ctx),
      systemPrompt: resolveConflictSystemPrompt(ctx),
      ...harnessStartOpts(config.harness.implement),
    })
    console.log(dim(`  agent: ${harness.kind} (${wt.branch})`))

    for await (const event of proc.events()) {
      if (event.kind === 'tool_use') console.log(dim(`  ${event.name}`))
      if (event.kind === 'text' && event.text.trim()) printBlock(event.text)
      if (event.kind === 'error') console.log(red(`  ${event.message}`))
    }
    const outcome = await proc.done
    if (!outcome.ok) {
      console.log(
        red(
          `  agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
        ),
      )
      return
    }

    await pushConflictFix({
      cwd: wt.path,
      branch: wt.branch,
      headRef: pr.headRefName,
      remote: config.forge.remote,
    })
    const status = await driver.getMergeStatus(root, pr.number)
    const ok = status === 'mergeable'
    console.log(
      ok
        ? green('  resolved and pushed; PR is mergeable')
        : yellow(`  pushed; GitHub reports ${status}`),
    )
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
    const header = ['PR', 'MERGE', 'BASE', 'HEAD', 'TITLE']
    const rows = resolved.map((p) => [
      `#${p.number}`,
      mergeLabel(p, base),
      p.baseRefName,
      p.headRefName,
      p.title,
    ])
    console.log(
      table([header, ...rows], (row, i) => {
        if (i === 0) return row.map(bold)
        const paint = row[1] === 'CONFLICT' ? red : row[1] === 'UNKNOWN' ? yellow : green
        return row.map((c, j) => (j === 1 ? paint(c) : c))
      }),
    )

    const conflicts = resolved.filter((p) => isConflicting(p, base))
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
    const tracker = makeTracker(config, root)
    for (const pr of conflicts) {
      try {
        const stamped = await stampIterationLabel({ cwd: root, pr })
        if (stamped !== null) {
          await tracker.setMetadata?.(stamped.taskId, { iterations: String(stamped.iteration) })
          console.log(dim(`  iteration ${stamped.iteration} for #${pr.number} (${stamped.taskId})`))
        }
      } catch (err) {
        console.log(
          red(`  iteration bump failed: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
      await resolveOne(pr, root, config, driver)
    }
  },
})
