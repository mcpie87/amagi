import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lintCommitMessage } from './commit-lint.ts'
import { type Config, watcherHarnessConfig } from './config.ts'
import type { PrDriver } from './drivers/pr.ts'
import { agentFailure, errMsg } from './errors.ts'
import { canTransition } from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { commitFooter } from './footer.ts'
import { withHeadReflogBypassCheck } from './git-bypass.ts'
import { runMandatoryWorkerChecks } from './mandatory-checks.ts'
import { cacheHome } from './paths.ts'
import { type PointlessVerdict, parsePointlessVerdict } from './pointless.ts'
import type { PrBodyMeta } from './pr-body.ts'
import {
  iterationsFromLabels,
  type PrInfo,
  prepareConflictWorktree,
  pushConflictFix,
  stampIterationLabel,
  taskIdFromAmagiBranch,
} from './pr-check.ts'
import { commitMessage, resolveConflictPrompt, resolveConflictSystemPrompt } from './prompt.ts'
import type { Store } from './store/store.ts'
import { recordWatcherAgentRun } from './watcher-agent.ts'

export type ConflictLogLevel = 'info' | 'ok' | 'warn' | 'error' | 'agent'

export type ResolveConflictOptions = {
  /** Registry key used to attribute a live conflict watcher seat. */
  repo?: string
  repoRoot: string
  repoName: string
  pr: PrInfo
  config: Config
  /** Forge driver, so the post-push merge verdict is read from the real forge. */
  driver: PrDriver
  /** Store used to mark the linked PR as conflicted once iterations run out. */
  store?: Store
  exec?: Exec | undefined
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness | undefined
  /** An explicit queue request bypasses the automatic dispatch limit. */
  manual?: boolean
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

/**
 * Stages the agent's resolution, since agents cannot write the index. A
 * conflicted path that still carries conflict markers stays unmerged so the
 * next dispatch is pointed at it; everything else is staged.
 */
export async function stageResolved(
  run: Exec,
  cwd: string,
  unmerged: readonly string[],
): Promise<void> {
  if (unmerged.length === 0) return
  const grep = await run(['git', 'grep', '-l', '-E', '^(<{7}|>{7})( |$)', '--', ...unmerged], {
    cwd,
  })
  if (grep.exitCode > 1)
    throw new Error(grep.stderr.trim() || 'git grep for conflict markers failed')
  const marked = new Set(grep.exitCode === 0 ? grep.stdout.split('\n').filter((l) => l !== '') : [])
  if (marked.size === 0) {
    await execOk(run, ['git', 'add', '-A'], { cwd })
    return
  }
  const resolved = unmerged.filter((p) => !marked.has(p))
  if (resolved.length > 0) await execOk(run, ['git', 'add', '-A', '--', ...resolved], { cwd })
}

/** Finishes the in-progress merge with the runner's message when the task is known. */
async function finishMerge(run: Exec, cwd: string, message?: string): Promise<void> {
  const head = await run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd })
  if (head.exitCode !== 0) return
  const args = message === undefined ? ['git', 'commit', '--no-edit'] : ['git', 'commit', '-F', '-']
  const commit = await run(args, { cwd, ...(message === undefined ? {} : { stdin: message }) })
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
  }
}

function watcherCommitMessage(
  task: { id: string; title: string } | null,
  prNumber: number,
  summary: string,
  meta: PrBodyMeta,
): string {
  const message =
    task === null
      ? `[pr-${prNumber}] Resolve conflicts\n\n${summary}\n\n${commitFooter(meta.harness, meta.model, meta.effort)}\n`
      : commitMessage(task, summary, meta)
  const errors = lintCommitMessage(message)
  if (errors.length > 0) throw new Error(`malformed commit message: ${errors.join('; ')}`)
  return message
}

/**
 * Marks the linked task as conflicted, so a PR that keeps re-conflicting
 * stops being re-dispatched. Returns whether it changed the state; a task
 * already settled or marked by an earlier dispatch is left where it is.
 */
function markPrMergeConflict(opts: ResolveConflictOptions, unmerged: readonly string[]): boolean {
  if (opts.store === undefined) return false
  const taskId = taskIdFromAmagiBranch(opts.pr.headRefName)
  if (taskId === null) return false
  const task = opts.store.task(taskId)
  if (task === null || !canTransition(task.state, 'pr_merge_conflict')) return false
  opts.store.append(taskId, {
    type: 'task.state',
    from: task.state,
    to: 'pr_merge_conflict',
    reason: `PR #${opts.pr.number} still has unmerged paths after ${opts.config.loop.conflictMaxIterations} conflict-resolution dispatches: ${unmerged.join(', ')}`,
  })
  return true
}

function parkAtNeedsHuman(opts: ResolveConflictOptions, reason: string): boolean {
  if (opts.store === undefined) return false
  const taskId = taskIdFromAmagiBranch(opts.pr.headRefName)
  if (taskId === null) return false
  const task = opts.store.task(taskId)
  if (task === null || !canTransition(task.state, 'needs_human')) return false
  opts.store.append(taskId, {
    type: 'task.state',
    from: task.state,
    to: 'needs_human',
    reason,
  })
  return true
}

/**
 * Resolves one PR's merge conflict: merges the base into the PR head in a
 * worktree, runs the agent over any conflicts, commits the resolved merge, and
 * pushes it back to the PR head ref. The agent resolves files and stops; the
 * runner stages and commits. Unmerged paths left behind re-dispatch the agent with the
 * file list and bump the per-PR Iteration counter, so a PR that keeps
 * re-conflicting sinks in the dispatch order; once iterations run out the
 * linked task is marked pr_merge_conflict. Shared by the check-prs command and
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
    const taskId = taskIdFromAmagiBranch(opts.pr.headRefName)
    const storedTask = taskId === null ? null : (opts.store?.task(taskId) ?? null)
    const task = storedTask === null ? null : { id: storedTask.id, title: storedTask.title }
    const harnessConfig = watcherHarnessConfig(opts.config, 'prConflict')
    const commitMeta: PrBodyMeta = {
      harness: harnessConfig.kind,
      model: harnessConfig.model ?? null,
      effort: harnessConfig.effort ?? null,
    }
    const cleanMergeMessage = watcherCommitMessage(
      task,
      opts.pr.number,
      `Merge: ${opts.config.repo.baseBranch} -> ${opts.pr.headRefName}.`,
      commitMeta,
    )
    const wt = await prepareConflictWorktree({
      repoRoot: opts.repoRoot,
      remote: opts.config.forge.remote,
      repoName: opts.repoName,
      worktreeRoot: opts.config.repo.worktreeRoot,
      baseBranch: opts.config.repo.baseBranch,
      pr: opts.pr,
      persona: opts.config.repo.persona,
      mergeMessage: cleanMergeMessage,
      exec: run,
    })
    log('info', `worktree: ${wt.path}`)
    iteration = iterationsFromLabels(opts.pr.labels)
    const verdictPath = join(tmpdir(), `amagi-conflict-${opts.pr.number}-${randomUUID()}.md`)
    let checkRound = 0
    let checkResults: import('./events.ts').CheckResult[] | undefined

    if (!wt.conflicted) {
      if (await conflictDiffEmpty(wt.path, wt.baseOid, run)) {
        const message = 'base already contains the PR work; skipped the empty merge push'
        log('warn', message)
        return { ok: false, message, iteration, contained: true }
      }
      const checks = await runMandatoryWorkerChecks(run, wt.path)
      const failed = checks.filter((result) => result.exitCode !== 0)
      if (failed.length > 0) {
        const detail = failed
          .map((result) => `$ ${result.command}\nexit ${result.exitCode}\n${result.output.trim()}`)
          .join('\n')
        const reason = `PR #${opts.pr.number} clean conflict merge failed mandatory checks:\n${detail}`
        const parked = parkAtNeedsHuman(opts, reason)
        const message = `${reason}${parked ? '; parked the task at needs_human' : ''}`
        log('error', message)
        return { ok: false, message, iteration }
      }
      await pushConflictFix({
        cwd: wt.path,
        branch: wt.branch,
        headRef: opts.pr.headRefName,
        remote: opts.config.forge.remote,
        exec: run,
      })
      const message = `base merges cleanly; pushed the merge to update the PR. Verification: ${checks.map((result) => `${result.command} passed`).join('; ')}`
      log('ok', message)
      return { ok: true, message, iteration }
    }

    for (;;) {
      const unmerged = await unmergedPaths(run, wt.path)
      if (unmerged.length === 0) {
        const results = await runMandatoryWorkerChecks(run, wt.path)
        if (results.every((result) => result.exitCode === 0)) {
          checkResults = results
          break
        }
        checkRound++
        checkResults = results
        const detail = results
          .filter((result) => result.exitCode !== 0)
          .map((result) => `$ ${result.command}\nexit ${result.exitCode}\n${result.output.trim()}`)
          .join('\n')
        if (checkRound > opts.config.loop.maxCheckRounds) {
          const reason = `PR #${opts.pr.number} conflict resolution failed mandatory checks:\n${detail}`
          const parked = parkAtNeedsHuman(opts, reason)
          const message = `${reason}${parked ? '; parked the task at needs_human' : ''}`
          log('error', message)
          return { ok: false, message, iteration }
        }
      }
      if (
        unmerged.length > 0 &&
        iteration >= opts.config.loop.conflictMaxIterations &&
        !opts.manual
      ) {
        const marked = markPrMergeConflict(opts, unmerged)
        const message = `unmerged paths remain after ${iteration} dispatches${marked ? '; task marked pr_merge_conflict' : ''}: ${unmerged.join(', ')}`
        log('error', message)
        return { ok: false, message, iteration }
      }
      if (unmerged.length > 0) {
        iteration++
        try {
          await stampIterationLabel({
            cwd: wt.path,
            remote: opts.config.forge.remote,
            pr: opts.pr,
            iteration,
            exec: run,
          })
        } catch (err) {
          log('warn', `iteration bump failed: ${errMsg(err)}`)
        }
      }

      const ctx = {
        pr: opts.pr,
        worktree: wt.path,
        branch: wt.branch,
        baseBranch: opts.config.repo.baseBranch,
        checks: opts.config.checks.commands,
        conflictFiles: unmerged,
        ...(checkResults === undefined ? {} : { checkResults }),
        outPath: verdictPath,
      }
      const harness = mk(harnessConfig)
      log('info', `resolving (dispatch ${iteration}/${opts.config.loop.conflictMaxIterations})`)
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
            seatPriority: 'low',
            env: { AMAGI_WORKTREE: wt.path, AMAGI_REPO_ROOT: opts.repoRoot },
            ...(opts.repo === undefined
              ? {}
              : { seatActivity: { repo: opts.repo, watcher: 'pr-conflict-watcher' } }),
          })
          const onEvent = (event: import('./events.ts').AgentEvent): void => {
            if (event.kind === 'tool_use') log('info', `[tool] ${event.name}`)
            else if (event.kind === 'text' && event.text.trim()) log('agent', event.text)
            else if (event.kind === 'error') log('error', event.message)
            else if (event.kind === 'status') log('info', event.message)
          }
          if (opts.store === undefined) {
            for await (const event of proc.events()) onEvent(event)
            return proc.done
          }
          return recordWatcherAgentRun(
            proc,
            {
              store: opts.store,
              role: 'implement',
              harness: harness.kind,
              source: `PR #${opts.pr.number} conflict dispatch ${iteration}`,
              cwd: wt.path,
            },
            onEvent,
          )
        },
        opts.onGitBypassed,
        true,
      )
      if (!outcome.ok) {
        const failedChecks = checkResults?.filter((result) => result.exitCode !== 0) ?? []
        const checkDetail = failedChecks
          .map((result) => `$ ${result.command}\nexit ${result.exitCode}\n${result.output.trim()}`)
          .join('\n')
        const reason =
          failedChecks.length === 0
            ? null
            : `PR #${opts.pr.number} conflict resolution failed mandatory checks:\n${checkDetail}\nRepair agent failed: ${agentFailure(outcome)}`
        const parked = reason === null ? false : parkAtNeedsHuman(opts, reason)
        const message =
          reason === null
            ? `agent failed: ${agentFailure(outcome)}`
            : `${reason}${parked ? '; parked the task at needs_human' : ''}`
        log('error', message)
        rmSync(verdictPath, { force: true })
        return { ok: false, message, iteration }
      }
      await stageResolved(run, wt.path, unmerged)
    }

    try {
      const rawVerdict = readFileSync(verdictPath, 'utf8').trim()
      if (rawVerdict !== '') verdict = parsePointlessVerdict(rawVerdict)
    } catch {
      // Missing verdicts do not block a real merge from being pushed.
    } finally {
      rmSync(verdictPath, { force: true })
    }

    const conflictSummary = `Merge: ${opts.config.repo.baseBranch} -> ${opts.pr.headRefName}. Conflict #${iteration}`
    await finishMerge(
      run,
      wt.path,
      watcherCommitMessage(task, opts.pr.number, conflictSummary, commitMeta),
    )
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
    const verification = `Verification: ${checkResults?.map((result) => `${result.command} passed`).join('; ') ?? 'not run'}`
    const message = ok
      ? `resolved and pushed; PR is mergeable${classification}. ${verification}`
      : `pushed; the forge reports ${status}${classification}. ${verification}`
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
