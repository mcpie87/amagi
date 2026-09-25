import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Config, watcherHarnessConfig } from './config.ts'
import type { PrDriver } from './drivers/pr.ts'
import { agentFailure, errMsg } from './errors.ts'
import { canTransition } from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { withHeadReflogBypassCheck } from './git-bypass.ts'
import { cacheHome } from './paths.ts'
import { type PointlessVerdict, parsePointlessVerdict } from './pointless.ts'
import {
  iterationsFromLabels,
  type PrInfo,
  prepareConflictWorktree,
  pushConflictFix,
  stampIterationLabel,
  taskIdFromAmagiBranch,
} from './pr-check.ts'
import { resolveConflictPrompt, resolveConflictSystemPrompt } from './prompt.ts'
import type { Store } from './store/store.ts'

export type ConflictLogLevel = 'info' | 'ok' | 'warn' | 'error' | 'agent'

export type ResolveConflictOptions = {
  repoRoot: string
  repoName: string
  pr: PrInfo
  config: Config
  /** Forge driver, so the post-push merge verdict is read from the real forge. */
  driver: PrDriver
  /** Store used to park the linked task at needs_human once iterations run out. */
  store?: Store
  exec?: Exec | undefined
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness | undefined
  /** Live log of the resolution, one line per event; the caller decides how to render it. */
  onLog?: (level: ConflictLogLevel, text: string) => void
  /** Called when the agent moves HEAD outside the expected commit operation. */
  onGitBypassed?: (entries: string[]) => void
}

export type ResolveConflictResult = {
  ok: boolean
  message: string
  /** Conflict-resolution dispatches this call ran for the PR, for the caller to mirror onto the linked task. */
  iteration: number
  /** The agent's task verdict, saved by the watcher for this PR head. */
  verdict?: PointlessVerdict
  /** Base already contains the PR's work: nothing was pushed and the PR needs closing, not resolving. */
  contained?: true
}

/** True when the merge result adds nothing on top of the merged base commit. */
async function conflictDiffEmpty(cwd: string, baseOid: string, run: Exec): Promise<boolean> {
  const diff = await run(['git', 'diff', '--quiet', baseOid, 'HEAD'], { cwd })
  if (diff.exitCode === 0) return true
  if (diff.exitCode === 1) return false
  throw new Error(diff.stderr.trim() || `git diff ${baseOid} HEAD failed`)
}

/** Paths still unmerged (in conflict); empty once every conflict is resolved. */
async function unmergedPaths(run: Exec, cwd: string): Promise<string[]> {
  const out = await execOk(run, ['git', 'diff', '--name-only', '--diff-filter=U'], { cwd })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** Finishes the in-progress merge with the default merge message, never a fresh one. */
async function finishMerge(run: Exec, cwd: string): Promise<void> {
  const head = await run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd })
  if (head.exitCode !== 0) return
  const commit = await run(['git', 'commit', '--no-edit'], { cwd })
  if (commit.exitCode !== 0) {
    throw new Error(`git commit --no-edit failed: ${(commit.stderr || commit.stdout).trim()}`)
  }
}

/**
 * Parks the linked task at needs_human, so a PR that keeps re-conflicting
 * stops being re-dispatched. Returns whether it parked: a task already done,
 * or already parked by an earlier dispatch, is left where it is.
 */
function parkAtNeedsHuman(opts: ResolveConflictOptions, unmerged: readonly string[]): boolean {
  if (opts.store === undefined) return false
  const taskId = taskIdFromAmagiBranch(opts.pr.headRefName)
  if (taskId === null) return false
  const task = opts.store.task(taskId)
  if (task === null || !canTransition(task.state, 'needs_human')) return false
  opts.store.append(taskId, {
    type: 'task.state',
    from: task.state,
    to: 'needs_human',
    reason: `PR #${opts.pr.number} still has unmerged paths after ${opts.config.loop.conflictMaxIterations} conflict-resolution dispatches: ${unmerged.join(', ')}`,
  })
  return true
}

/**
 * Resolves one PR's merge conflict: merges the base into the PR head in a
 * worktree, runs the agent over any conflicts, commits the resolved merge, and
 * pushes it back to the PR head ref. The agent resolves files and stops; the
 * runner commits. Unmerged paths left behind re-dispatch the agent with the
 * file list and bump the per-PR Iteration counter, so a PR that keeps
 * re-conflicting sinks in the dispatch order; once iterations run out the
 * linked task is parked at needs_human. Shared by the check-prs command and
 * the periodic PR conflict watcher. Never throws: failures come back as
 * `ok: false` and are logged so one broken PR does not abort the caller's loop.
 */
export async function resolveConflict(
  opts: ResolveConflictOptions,
): Promise<ResolveConflictResult> {
  const run = opts.exec ?? defaultExec
  const mk = opts.makeHarnessFn ?? makeHarness
  const log = (level: ConflictLogLevel, text: string): void => opts.onLog?.(level, text)
  let iteration = 0
  let verdict: PointlessVerdict | undefined

  try {
    const wt = await prepareConflictWorktree({
      repoRoot: opts.repoRoot,
      repoName: opts.repoName,
      worktreeRoot: opts.config.repo.worktreeRoot,
      baseBranch: opts.config.repo.baseBranch,
      pr: opts.pr,
      persona: opts.config.repo.persona,
      exec: run,
    })
    log('info', `worktree: ${wt.path}`)
    iteration = iterationsFromLabels(opts.pr.labels)
    const verdictPath = join(tmpdir(), `amagi-conflict-${opts.pr.number}-${randomUUID()}.md`)

    if (!wt.conflicted) {
      if (await conflictDiffEmpty(wt.path, wt.baseOid, run)) {
        const message = 'base already contains the PR work; skipped the empty merge push'
        log('warn', message)
        return { ok: false, message, iteration, contained: true }
      }
      await pushConflictFix({
        cwd: wt.path,
        branch: wt.branch,
        headRef: opts.pr.headRefName,
        remote: opts.config.forge.remote,
        exec: run,
      })
      const message = 'base merges cleanly; pushed the merge to update the PR'
      log('ok', message)
      return { ok: true, message, iteration }
    }

    for (;;) {
      const unmerged = await unmergedPaths(run, wt.path)
      if (unmerged.length === 0) break
      if (iteration >= opts.config.loop.conflictMaxIterations) {
        const parked = parkAtNeedsHuman(opts, unmerged)
        const message = `unmerged paths remain after ${iteration} dispatches${parked ? '; parked the task at needs_human' : ''}: ${unmerged.join(', ')}`
        log('error', message)
        return { ok: false, message, iteration }
      }
      iteration++
      try {
        await stampIterationLabel({ cwd: wt.path, pr: opts.pr, iteration, exec: run })
      } catch (err) {
        log('warn', `iteration bump failed: ${errMsg(err)}`)
      }

      const ctx = {
        pr: opts.pr,
        worktree: wt.path,
        branch: wt.branch,
        baseBranch: opts.config.repo.baseBranch,
        checks: opts.config.checks.commands,
        conflictFiles: unmerged,
        outPath: verdictPath,
      }
      const harnessConfig = watcherHarnessConfig(opts.config, 'prConflict')
      const harness = mk(harnessConfig)
      log('info', `agent: ${harness.kind} (${wt.branch})`)
      const outcome = await withHeadReflogBypassCheck(
        wt.path,
        run,
        async () => {
          const proc = harness.start({
            cwd: wt.path,
            prompt: resolveConflictPrompt(ctx),
            systemPrompt: resolveConflictSystemPrompt(ctx),
            ...harnessStartOpts(harnessConfig),
          })
          for await (const event of proc.events()) {
            if (event.kind === 'tool_use') log('info', `[tool] ${event.name}`)
            else if (event.kind === 'text' && event.text.trim()) log('agent', event.text)
            else if (event.kind === 'error') log('error', event.message)
            else if (event.kind === 'status') log('info', event.message)
          }
          return proc.done
        },
        opts.onGitBypassed,
      )
      if (!outcome.ok) {
        const message = `agent failed: ${agentFailure(outcome)}`
        log('error', message)
        rmSync(verdictPath, { force: true })
        return { ok: false, message, iteration }
      }
    }

    try {
      const rawVerdict = readFileSync(verdictPath, 'utf8').trim()
      if (rawVerdict !== '') verdict = parsePointlessVerdict(rawVerdict)
    } catch {
      // Missing verdicts do not block a real merge from being pushed.
    } finally {
      rmSync(verdictPath, { force: true })
    }

    await finishMerge(run, wt.path)
    if (await conflictDiffEmpty(wt.path, wt.baseOid, run)) {
      const classification = verdict?.verdict ? ` (${verdict.verdict})` : ''
      const message = `base already contains the PR work; skipped the empty merge push${classification}`
      log('warn', message)
      return {
        ok: false,
        message,
        iteration,
        contained: true,
        ...(verdict === undefined ? {} : { verdict }),
      }
    }
    await pushConflictFix({
      cwd: wt.path,
      branch: wt.branch,
      headRef: opts.pr.headRefName,
      remote: opts.config.forge.remote,
      exec: run,
    })
    const status = await opts.driver.getMergeStatus(opts.repoRoot, opts.pr.number)
    const ok = status === 'mergeable'
    const classification =
      verdict?.verdict && verdict.verdict !== 'RESOLVED'
        ? `; agent verdict: ${verdict.verdict}`
        : ''
    const message = ok
      ? `resolved and pushed; PR is mergeable${classification}`
      : `pushed; the forge reports ${status}${classification}`
    const level =
      ok && (verdict?.verdict === undefined || verdict.verdict === 'RESOLVED') ? 'ok' : 'warn'
    log(level, message)
    return { ok, message, iteration, ...(verdict === undefined ? {} : { verdict }) }
  } catch (err) {
    const message = errMsg(err)
    log('error', message)
    return { ok: false, message, iteration }
  }
}

/**
 * Last-attempted PR head and base head per conflicting PR, so the watcher can
 * skip unchanged pairs. `contained` marks a head whose work base already has;
 * base moves cannot undo that, so only a new PR head re-arms it.
 */
export type ConflictWatchState = Record<
  string,
  { headOid: string; baseOid?: string; verdict?: PointlessVerdict; contained?: boolean }
>

export function conflictWatchPath(repoName: string): string {
  return join(cacheHome(), 'amagi', 'conflicts', `${repoName}.json`)
}

export function readConflictWatch(path: string): ConflictWatchState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConflictWatchState
  } catch {
    return {}
  }
}

export function saveConflictWatch(path: string, state: ConflictWatchState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state))
}
