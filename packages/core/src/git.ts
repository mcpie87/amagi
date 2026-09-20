export class GitError extends Error {}

export function git(args: string[], cwd: string = process.cwd()): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.toString().trim()}`,
    )
  }
  return r.stdout.toString().trim()
}

export function repoRoot(cwd: string = process.cwd()): string {
  return git(['rev-parse', '--show-toplevel'], cwd)
}

export function repoName(cwd: string = process.cwd()): string {
  const root = repoRoot(cwd)
  return root.slice(root.lastIndexOf('/') + 1)
}
