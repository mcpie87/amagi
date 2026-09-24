import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import type { PrDriver } from './drivers/pr.ts'
import { agentFailure, errMsg } from './errors.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { withHeadReflogBypassCheck } from './git-bypass.ts'
import { cacheHome } from './paths.ts'
import { type PointlessVerdict, parsePointlessVerdict } from './pointless.ts'
import { type PrInfo, prepareConflictWorktree, pushConflictFix } from './pr-check.ts'
import { resolveConflictPrompt, resolveConflictSystemPrompt } from './prompt.ts'

export type ConflictLogLevel = 'info' | 'ok' | 'warn' | 'error' | 'agent'

export type ResolveConflictOptions = {
  repoRoot: string
  repoName: string
  pr: PrInfo
  config: Config
  /** Forge driver, so the post-push merge verdict is read from the real forge. */
  driver: PrDriver
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
  /** The agent's task verdict, saved by the watcher for this PR head. */
  verdict?: PointlessVerdict
}

async function conflictDiffEmpty(cwd: string, baseBranch: string, run: Exec): Promise<boolean> {
  const diff = await run(['git', 'diff', '--quiet', `origin/${baseBranch}..HEAD`], { cwd })
  if (diff.exitCode === 0) return true
  if (diff.exitCode === 1) return false
  throw new Error(diff.stderr.trim() || `git diff origin/${baseBranch}..HEAD failed`)
}

/**
 * Resolves one PR's merge conflict: merges the base into the PR head in a
 * worktree, runs the agent over any conflicts, and pushes the resolved merge
 * back to the PR head ref. Shared by the check-prs command and the periodic
 * PR conflict watcher. Never throws: failures come back as `ok: false` and
 * are logged so one broken PR does not abort the caller's loop.
 */
export async function resolveConflict(
  opts: ResolveConflictOptions,
): Promise<ResolveConflictResult> {
  const run = opts.exec ?? defaultExec
  const mk = opts.makeHarnessFn ?? makeHarness
  const log = (level: ConflictLogLevel, text: string): void => opts.onLog?.(level, text)

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

    let verdict: PointlessVerdict | undefined
    if (!wt.conflicted) {
      if (await conflictDiffEmpty(wt.path, opts.config.repo.baseBranch, run)) {
        const message = 'base already contains the PR work; skipped the empty merge push'
        log('warn', message)
        return { ok: false, message }
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
      return { ok: true, message }
    }

    const ctx = {
      pr: opts.pr,
      worktree: wt.path,
      branch: wt.branch,
      baseBranch: opts.config.repo.baseBranch,
      checks: opts.config.checks.commands,
    }
    const harness = mk(opts.config.harness.implement)
    const verdictPath = join(tmpdir(), `amagi-conflict-${opts.pr.number}-${randomUUID()}.md`)
    log('info', `agent: ${harness.kind} (${wt.branch})`)

    const outcome = await withHeadReflogBypassCheck(
      wt.path,
      run,
      async () => {
        const proc = harness.start({
          cwd: wt.path,
          prompt: resolveConflictPrompt({ ...ctx, outPath: verdictPath }),
          systemPrompt: resolveConflictSystemPrompt({ ...ctx, outPath: verdictPath }),
          ...harnessStartOpts(opts.config.harness.implement),
        })
        for await (const event of proc.events()) {
          if (event.kind === 'tool_use') log('info', `[tool] ${event.name}`)
          else if (event.kind === 'text' && event.text.trim()) log('agent', event.text)
          else if (event.kind === 'error') log('error', event.message)
        }
        return proc.done
      },
      opts.onGitBypassed,
    )
    if (!outcome.ok) {
      rmSync(verdictPath, { force: true })
      const message = `agent failed: ${agentFailure(outcome)}`
      log('error', message)
      return { ok: false, message }
    }

    try {
      const rawVerdict = readFileSync(verdictPath, 'utf8').trim()
      if (rawVerdict !== '') verdict = parsePointlessVerdict(rawVerdict)
    } catch {
      // Missing verdicts do not block a real merge from being pushed.
    } finally {
      rmSync(verdictPath, { force: true })
    }

    if (await conflictDiffEmpty(wt.path, opts.config.repo.baseBranch, run)) {
      const classification = verdict?.verdict ? ` (${verdict.verdict})` : ''
      const message = `base already contains the PR work; skipped the empty merge push${classification}`
      log('warn', message)
      return { ok: false, message, ...(verdict === undefined ? {} : { verdict }) }
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
    return { ok, message, ...(verdict === undefined ? {} : { verdict }) }
  } catch (err) {
    const message = errMsg(err)
    log('error', message)
    return { ok: false, message }
  }
}

/** Last-attempted head per conflicting PR, including its classification when available. */
export type ConflictWatchState = Record<string, { headOid: string; verdict?: PointlessVerdict }>

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
