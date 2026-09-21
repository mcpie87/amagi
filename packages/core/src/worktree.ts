import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import { configHome } from './paths.ts'

const MAX_SLUG_WORDS = 5

/**
 * Polish titles are common here and NFKD leaves stroked letters alone, so the
 * few that have no combining form are mapped before the generic pass.
 */
const TRANSLITERATE: Record<string, string> = {
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  ø: 'o',
  Ø: 'o',
  ß: 'ss',
}

export function slugify(title: string, maxWords = MAX_SLUG_WORDS): string {
  const folded = [...title].map((c) => TRANSLITERATE[c] ?? c).join('')
  const ascii = folded.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const words = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)
  return words.length > 0 ? words.join('-') : 'task'
}

export function branchName(taskId: string, title: string): string {
  return `amagi/${taskId}-${slugify(title)}`
}

export function worktreeDirName(repoName: string, taskId: string, title: string): string {
  return `${repoName}-${taskId}-${slugify(title)}`
}

export type WorktreeSpec = {
  path: string
  branch: string
}

export type CreateWorktreeOptions = {
  repoRoot: string
  repoName: string
  taskId: string
  title: string
  baseBranch: string
  worktreeRoot: string
  setupCmd?: string | null
  /** Git persona name; the matching ~/.config/git/personas/<name>.gitconfig is included. */
  persona?: string | null
  exec?: Exec
}

/** Absolute path of the persona gitconfig, or null when it does not exist. */
export function personaGitconfig(name: string): string | null {
  const file = join(configHome(), 'git', 'personas', `${name}.gitconfig`)
  return existsSync(file) ? file : null
}

/**
 * Applies a persona to a worktree via include.path in the worktree-scoped
 * config, so commits in this worktree (and any PR opened from it) carry the
 * persona's user identity without touching the shared repo config.
 */
export async function applyPersona(run: Exec, cwd: string, persona: string): Promise<void> {
  const file = personaGitconfig(persona)
  if (file === null) throw new Error(`persona not found: ${persona}`)
  await execOk(run, ['git', 'config', 'extensions.worktreeConfig', 'true'], { cwd })
  await execOk(run, ['git', 'config', '--worktree', 'include.path', file], { cwd })
}

export async function branchExists(run: Exec, repoRoot: string, branch: string): Promise<boolean> {
  const r = await run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
  })
  return r.exitCode === 0
}

/**
 * Idempotent: re-running for a task that already has a worktree adopts it
 * rather than failing, so a crashed run can be resumed.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeSpec> {
  const run = opts.exec ?? defaultExec
  const branch = branchName(opts.taskId, opts.title)
  const path = join(opts.worktreeRoot, worktreeDirName(opts.repoName, opts.taskId, opts.title))

  if (!existsSync(path)) {
    const exists = await branchExists(run, opts.repoRoot, branch)
    const args = exists
      ? ['git', 'worktree', 'add', path, branch]
      : ['git', 'worktree', 'add', '-b', branch, path, opts.baseBranch]
    await execOk(run, args, { cwd: opts.repoRoot })
  }

  if (opts.persona) {
    await applyPersona(run, path, opts.persona)
  }

  if (opts.setupCmd) {
    await execOk(run, ['sh', '-c', opts.setupCmd], { cwd: path })
  }

  return { path, branch }
}
