import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveRegistry } from '@amagi/core'

const git = (cwd: string, args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

test('currentRepo resolves a linked worktree to its registered main repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amagi-cli-repo-'))
  const repo = join(dir, 'main-repo')
  const worktree = join(dir, 'task-worktree')
  const registry = join(dir, 'registry.json')

  try {
    mkdirSync(repo)
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    writeFileSync(join(repo, 'README.md'), '# demo\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'init'])
    git(repo, ['worktree', 'add', '-q', '-b', 'amagi/am-test-linked', worktree, 'main'])

    saveRegistry(
      [
        {
          key: 'registered-repo',
          name: 'Main repo',
          path: repo,
          workers: true,
          watchers: true,
          gitIdentity: null,
        },
      ],
      registry,
    )

    for (const repoRoot of [undefined, repo]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AMAGI_REGISTRY: registry,
        AMAGI_DB: join(dir, 'repo.db'),
      }
      if (repoRoot === undefined) delete env.AMAGI_REPO_ROOT
      else env.AMAGI_REPO_ROOT = repoRoot
      const result = Bun.spawnSync(
        [
          process.execPath,
          '--eval',
          `import { currentRepo } from ${JSON.stringify(join(import.meta.dir, 'repo.ts'))};
          const { key, root, store } = currentRepo();
          store.close();
          console.log(JSON.stringify({ key, root }));`,
        ],
        { cwd: worktree, env, stdout: 'pipe', stderr: 'pipe' },
      )
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({ key: 'registered-repo', root: repo })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
