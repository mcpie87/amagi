import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from './config.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import { cacheHome } from './paths.ts'
import { type PrInfo, prepareConflictWorktree, prMergeStatus, pushConflictFix } from './pr-check.ts'
import { resolveConflictPrompt, resolveConflictSystemPrompt } from './prompt.ts'

export type ConflictLogLevel = 'info' | 'ok' | 'warn' | 'error' | 'agent'

export type ResolveConflictOptions = {
  repoRoot: string
  repoName: string
  pr: PrInfo
  config: Config
  exec?: Exec | undefined
  /** Test seam: the harness factory, defaulting to the configured one. */
  makeHarnessFn?: typeof makeHarness | undefined
  /** Live log of the resolution, one line per event; the caller decides how to render it. */
  onLog?: (level: ConflictLogLevel, text: string) => void
}

export type ResolveConflictResult = {
  ok: boolean
  message: string
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

    if (!wt.conflicted) {
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
    const proc = harness.start({
      cwd: wt.path,
      prompt: resolveConflictPrompt(ctx),
      systemPrompt: resolveConflictSystemPrompt(ctx),
      ...harnessStartOpts(opts.config.harness.implement),
    })
    log('info', `agent: ${harness.kind} (${wt.branch})`)

    for await (const event of proc.events()) {
      if (event.kind === 'tool_use') log('info', `[tool] ${event.name}`)
      else if (event.kind === 'text' && event.text.trim()) log('agent', event.text)
      else if (event.kind === 'error') log('error', event.message)
    }
    const outcome = await proc.done
    if (!outcome.ok) {
      const message = `agent failed: ${
        outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`
      }`
      log('error', message)
      return { ok: false, message }
    }

    await pushConflictFix({
      cwd: wt.path,
      branch: wt.branch,
      headRef: opts.pr.headRefName,
      remote: opts.config.forge.remote,
      exec: run,
    })
    const status = await prMergeStatus(opts.repoRoot, opts.pr.number, run)
    const ok = status.mergeable === 'MERGEABLE' || status.mergeStateStatus === 'CLEAN'
    const message = ok
      ? 'resolved and pushed; PR is mergeable'
      : `pushed; GitHub reports ${status.mergeStateStatus}`
    log(ok ? 'ok' : 'warn', message)
    return { ok, message }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('error', message)
    return { ok: false, message }
  }
}

/** Last-attempted head per conflicting PR, so the watcher can skip unchanged heads. */
export type ConflictWatchState = Record<string, { headOid: string }>

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
