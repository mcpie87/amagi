import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import { ghEnv } from './drivers/forge-cred.ts'
import { AMAGI_LABEL, NEEDS_CLOSING_LABEL, type PrDriver } from './drivers/pr.ts'
import type { Tracker, TrackerTask } from './drivers/types.ts'
import { agentFailure, errMsg } from './errors.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { resolveTaskId } from './mentions.ts'
import { cacheHome } from './paths.ts'
import { type PrInfo, prepareConflictWorktree } from './pr-check.ts'
import { pointlessPrompt, pointlessSystemPrompt } from './prompt.ts'
import type { Store } from './store/store.ts'

export type FlagPointlessOptions = {
  store: Store
  tracker: Tracker
  driver: PrDriver
  /** Repo the open PRs live in, so the forge CLI can resolve them. */
  cwd: string
  repoName: string
  prs: PrInfo[]
  config: Config
  exec?: Exec
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness
  /** Per-PR results for watcher run history. Recording failures never changes the pass. */
  onAction?: (pr: PrInfo, result: string, level: 'info' | 'error') => void
}

export type FlagPointlessResult = { flagged: number; cleared: number }

export const POINTLESS_VERDICTS = ['RESOLVED', 'CLOSE TASK', 'NEW TASK', 'REPHRASE TASK'] as const
export type PointlessVerdictKind = (typeof POINTLESS_VERDICTS)[number]

export type PointlessVerdict = {
  /** The verdict line the agent picked; null when the file has no recognized line. */
  verdict: PointlessVerdictKind | null
  /** The `REASONING:` section: why this diff is empty in the context of the task. */
  reasoning: string
  /** The `PROPOSAL:` section: the recommendation, posted to the tracker. */
  proposal: string
}

/** Text between the `START:` and `END:` heading lines, trimmed; '' when either is missing. */
function section(lines: readonly string[], start: string, end?: string): string {
  const startIdx = lines.findIndex((l) => l.trim().toUpperCase() === `${start}:`)
  if (startIdx === -1) return ''
  const body: string[] = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (end !== undefined && line.trim().toUpperCase() === `${end}:`) break
    body.push(line)
  }
  return body.join('\n').trim()
}

export function parsePointlessVerdict(raw: string): PointlessVerdict {
  const lines = raw.split('\n')
  const first = lines[0]?.trim().toUpperCase() ?? ''
  const verdict = (POINTLESS_VERDICTS as readonly string[]).includes(first)
    ? (first as PointlessVerdictKind)
    : null
  return {
    verdict,
    reasoning: section(lines, 'REASONING', 'PROPOSAL'),
    proposal: section(lines, 'PROPOSAL'),
  }
}

/**
 * The fallback reasoning posted when no agent verdict is available: the close
 * button and the decision live there, and the tracker comment survives once
 * the PR is gone. Amagi flags, a human closes.
 */
export function pointlessReason(pr: PrInfo): string {
  return [
    `This pull request appears to be pointless: its diff against \`${pr.baseRefName}\` is empty, so there is nothing to merge.`,
    '',
    'The work may have already landed another way. If so, close this pull request; it will not be closed automatically.',
  ].join('\n')
}

/**
 * The v1 pointlessness criterion, checked mechanically: the three-dot diff
 * against base is empty. GitHub-only, matching the gh-bound PR list that feeds
 * the watcher; an empty diff already subsumes superseded work, since changes
 * that landed on base by another route make the diff go empty by itself.
 */
export async function prDiffEmpty(
  cwd: string,
  number: number,
  run: Exec = defaultExec,
): Promise<boolean> {
  const r = await run(['gh', 'pr', 'diff', String(number)], { cwd, env: ghEnv() })
  if (r.exitCode !== 0) {
    throw new Error(r.stderr.trim() || `gh pr diff ${number} failed`)
  }
  return r.stdout.trim() === ''
}

/** Last-evaluated head per amagi PR, so an unchanged PR is not re-commented every tick. */
export type PointlessWatchState = Record<string, { headOid: string; flagged: boolean }>

export function pointlessWatchPath(repoName: string): string {
  return join(cacheHome(), 'amagi', 'pointless', `${repoName}.json`)
}

export function readPointlessWatch(path: string): PointlessWatchState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PointlessWatchState
  } catch {
    return {}
  }
}

export function savePointlessWatch(path: string, state: PointlessWatchState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
}

/**
 * The task text an agent verdict sees, resolved per am-qji (PR body trailer,
 * then branch against the tracker's open ids, then the PR title) so the
 * verdict still works when the local store has no row for the PR. Never
 * throws: a resolution or lookup failure just yields null.
 */
async function taskForVerdict(
  pr: PrInfo,
  tracker: Tracker,
  storeTaskId: string | null,
): Promise<TrackerTask | null> {
  let id = storeTaskId
  try {
    id = (await resolveTaskId(pr, tracker)) ?? id
  } catch (err) {
    console.warn(`pr pointless task id #${pr.number}: ${errMsg(err)}`)
  }
  if (id === null) return null
  try {
    return await tracker.get(id)
  } catch (err) {
    console.warn(`pr pointless task ${id}: ${errMsg(err)}`)
    return null
  }
}

type JudgePointlessOptions = {
  /** Repo root the PR worktree is prepared from. */
  root: string
  repoName: string
  pr: PrInfo
  /** The task the PR was opened for, or null when it could not be resolved. */
  task: TrackerTask | null
  config: Config
  exec?: Exec
  makeHarnessFn?: typeof makeHarness
}

/**
 * The agent verdict on an empty-diff PR: the mechanical check established
 * that the diff is empty, the agent reads the repo and the task and writes a
 * verdict to a file (see pointlessPrompt). Returns null on any failure so the
 * caller's mechanical flagging still happens with the static reason.
 */
async function judgePointless(opts: JudgePointlessOptions): Promise<PointlessVerdict | null> {
  const run = opts.exec ?? defaultExec
  const mk = opts.makeHarnessFn ?? makeHarness
  try {
    const wt = await prepareConflictWorktree({
      repoRoot: opts.root,
      repoName: opts.repoName,
      worktreeRoot: opts.config.repo.worktreeRoot,
      baseBranch: opts.config.repo.baseBranch,
      pr: opts.pr,
      persona: opts.config.repo.persona,
      exec: run,
    })
    const outDir = mkdtempSync(join(tmpdir(), `amagi-pointless-${opts.pr.number}-`))
    const outPath = join(outDir, 'verdict.md')
    try {
      const proc = mk(opts.config.harness.implement).start({
        cwd: wt.path,
        prompt: pointlessPrompt({
          pr: opts.pr,
          task: opts.task,
          baseBranch: opts.config.repo.baseBranch,
          outPath,
        }),
        systemPrompt: pointlessSystemPrompt(),
        ...harnessStartOpts(opts.config.harness.implement),
      })
      const outcome = await proc.done
      if (!outcome.ok) {
        console.warn(`pr pointless verdict #${opts.pr.number}: ${agentFailure(outcome)}`)
        return null
      }
      const raw = readFileSync(outPath, 'utf8').trim()
      return raw === '' ? null : parsePointlessVerdict(raw)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  } catch (err) {
    console.warn(`pr pointless verdict #${opts.pr.number}: ${errMsg(err)}`)
    return null
  }
}

/**
 * Flags amagi-provenance open PRs whose diff against base is empty: adds the
 * needs-closing label, comments the reasoning on the PR and the proposal on
 * the tracker issue, and parks the task in pr_flagged. The empty diff is the
 * mechanical trigger; an agent verdict on top supplies the reasoning (why the
 * diff is empty in the context of the task) and a proposal (close, new, or
 * rephrase the task), and never acts on either. A later tick whose PR no
 * longer qualifies (real commits pushed) removes the label and returns the
 * task to pr_open, without a second comment. Never closes a pull request.
 * PRs without the amagi label are skipped regardless of their diff, so a
 * human's PR is never touched.
 */
export async function flagPointlessPrs(opts: FlagPointlessOptions): Promise<FlagPointlessResult> {
  const run = opts.exec ?? defaultExec
  const tasks = new Map(
    opts.store.tasks({ states: ['pr_open', 'pr_flagged'] }).map((t) => [t.prNumber, t]),
  )
  const statePath = pointlessWatchPath(opts.repoName)
  const state = readPointlessWatch(statePath)
  const nextState: PointlessWatchState = {}
  let flagged = 0
  let cleared = 0
  const report = (pr: PrInfo, result: string, level: 'info' | 'error'): void => {
    try {
      opts.onAction?.(pr, result, level)
    } catch (err) {
      console.warn(`pr pointless history #${pr.number}: ${errMsg(err)}`)
    }
  }

  for (const pr of opts.prs) {
    if (!pr.labels.includes(AMAGI_LABEL)) continue
    const key = String(pr.number)
    const headOid = pr.headRefOid ?? ''
    const seen = state[key]
    if (seen !== undefined && seen.headOid === headOid) {
      nextState[key] = seen
      continue
    }
    let empty: boolean
    try {
      empty = await prDiffEmpty(opts.cwd, pr.number, run)
    } catch (err) {
      console.warn(`pr pointless #${pr.number}: ${errMsg(err)}`)
      report(pr, `pointlessness check failed: ${errMsg(err)}`, 'error')
      continue
    }
    const task = tasks.get(pr.number)
    if (empty) {
      if (task !== undefined && task.state === 'pr_open') {
        try {
          await opts.driver.addLabel(opts.cwd, pr.number, NEEDS_CLOSING_LABEL)
          const verdict = await judgePointless({
            root: opts.cwd,
            repoName: opts.repoName,
            pr,
            task: await taskForVerdict(pr, opts.tracker, task.id),
            config: opts.config,
            ...(opts.exec === undefined ? {} : { exec: opts.exec }),
            ...(opts.makeHarnessFn === undefined ? {} : { makeHarnessFn: opts.makeHarnessFn }),
          })
          const reasoning =
            verdict !== null && verdict.reasoning !== '' ? verdict.reasoning : pointlessReason(pr)
          const proposal =
            verdict !== null && verdict.proposal !== '' ? verdict.proposal : pointlessReason(pr)
          await opts.driver.postComment(opts.cwd, pr.number, reasoning)
          await opts.tracker.comment(task.id, proposal)
          opts.store.append(task.id, {
            type: 'task.state',
            from: 'pr_open',
            to: 'pr_flagged',
            reason: reasoning,
          })
          flagged++
          report(pr, 'empty-diff PR flagged for review', 'info')
        } catch (err) {
          console.warn(`pr pointless #${pr.number}: ${errMsg(err)}`)
          report(pr, `failed to flag empty-diff PR: ${errMsg(err)}`, 'error')
          continue
        }
      }
      nextState[key] = { headOid, flagged: true }
    } else {
      if (task !== undefined && task.state === 'pr_flagged') {
        try {
          await opts.driver.removeLabel(opts.cwd, pr.number, NEEDS_CLOSING_LABEL)
          opts.store.append(task.id, {
            type: 'task.state',
            from: 'pr_flagged',
            to: 'pr_open',
            reason: 'PR is no longer pointless; its diff against base is not empty',
          })
          cleared++
          report(pr, 'empty-diff flag cleared after PR changes', 'info')
        } catch (err) {
          console.warn(`pr pointless #${pr.number}: ${errMsg(err)}`)
          report(pr, `failed to clear empty-diff flag: ${errMsg(err)}`, 'error')
          continue
        }
      }
      nextState[key] = { headOid, flagged: false }
    }
  }
  savePointlessWatch(statePath, nextState)
  return { flagged, cleared }
}
