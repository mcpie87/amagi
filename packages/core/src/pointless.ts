import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ghEnv } from './drivers/forge-cred.ts'
import { AMAGI_LABEL, NEEDS_CLOSING_LABEL, type PrDriver } from './drivers/pr.ts'
import type { Tracker } from './drivers/types.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { cacheHome } from './paths.ts'
import type { PrInfo } from './pr-check.ts'
import type { Store } from './store/store.ts'

export type FlagPointlessOptions = {
  store: Store
  tracker: Tracker
  driver: PrDriver
  /** Repo the open PRs live in, so the forge CLI can resolve them. */
  cwd: string
  repoName: string
  prs: PrInfo[]
  exec?: Exec
}

export type FlagPointlessResult = { flagged: number; cleared: number }

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The reasoning posted to the PR and the tracker issue: the close button and
 * the decision live there, and the tracker comment survives once the PR is
 * gone. Amagi flags, a human closes.
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
 * Flags amagi-provenance open PRs whose diff against base is empty: adds the
 * needs-closing label, comments the reasoning on the PR and the tracker issue,
 * and parks the task in pr_flagged. A later tick whose PR no longer qualifies
 * (real commits pushed) removes the label and returns the task to pr_open,
 * without a second comment. Never closes a pull request. PRs without the amagi
 * label are skipped regardless of their diff, so a human's PR is never touched.
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
      continue
    }
    const task = tasks.get(pr.number)
    if (empty) {
      if (task !== undefined && task.state === 'pr_open') {
        try {
          await opts.driver.addLabel(opts.cwd, pr.number, NEEDS_CLOSING_LABEL)
          await opts.driver.postComment(opts.cwd, pr.number, pointlessReason(pr))
          await opts.tracker.comment(task.id, pointlessReason(pr))
          opts.store.append(task.id, {
            type: 'task.state',
            from: 'pr_open',
            to: 'pr_flagged',
            reason: pointlessReason(pr),
          })
          flagged++
        } catch (err) {
          console.warn(`pr pointless #${pr.number}: ${errMsg(err)}`)
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
        } catch (err) {
          console.warn(`pr pointless #${pr.number}: ${errMsg(err)}`)
          continue
        }
      }
      nextState[key] = { headOid, flagged: false }
    }
  }
  savePointlessWatch(statePath, nextState)
  return { flagged, cleared }
}
