import {
  type Config,
  isConflicting,
  listOpenPrs,
  loadConfig,
  makeHarness,
  type PrInfo,
  prepareConflictWorktree,
  prMergeStatus,
  pushConflictFix,
  repoName,
  repoRoot,
  resolveConflictPrompt,
  resolveConflictSystemPrompt,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red, table, yellow } from '../format.ts'

function printBlock(text: string): void {
  for (const line of text.trim().split('\n')) console.log(`  ${line}`)
}

function mergeLabel(p: PrInfo, baseBranch: string): string {
  if (isConflicting(p, baseBranch)) return 'CONFLICT'
  if (p.mergeable === 'UNKNOWN' || p.mergeStateStatus === 'UNKNOWN') return 'UNKNOWN'
  return 'CLEAN'
}

async function resolveOne(pr: PrInfo, root: string, config: Config): Promise<void> {
  console.log(`\n${bold(`#${pr.number}`)}  ${pr.title}`)
  console.log(dim(`  ${pr.url}`))
  try {
    const wt = await prepareConflictWorktree({
      repoRoot: root,
      repoName: repoName(root),
      worktreeRoot: config.repo.worktreeRoot,
      baseBranch: config.repo.baseBranch,
      pr,
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
      ...(config.harness.implement.model === undefined
        ? {}
        : { model: config.harness.implement.model }),
      ...(config.harness.implement.effort === undefined
        ? {}
        : { effort: config.harness.implement.effort }),
      permissions: config.harness.implement.permissions,
      extraArgs: config.harness.implement.extraArgs,
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
    const status = await prMergeStatus(root, pr.number)
    const ok = status.mergeable === 'MERGEABLE' || status.mergeStateStatus === 'CLEAN'
    console.log(
      ok
        ? green('  resolved and pushed; PR is mergeable')
        : yellow(`  pushed; GitHub reports ${status.mergeStateStatus}`),
    )
  } catch (err) {
    console.log(red(`  ${err instanceof Error ? err.message : String(err)}`))
  }
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
    const header = ['PR', 'MERGE', 'BASE', 'HEAD', 'TITLE']
    const rows = prs.map((p) => [
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

    const conflicts = prs.filter((p) => isConflicting(p, base))
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
    for (const pr of conflicts) {
      await resolveOne(pr, root, config)
    }
  },
})
