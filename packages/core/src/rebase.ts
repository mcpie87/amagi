import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.ts'
import { forgeToken, gitTokenConfig } from './drivers/forge-cred.ts'
import { assertSafePushDestination } from './drivers/push-safety.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import type { PrInfo } from './pr-check.ts'
import { withPrWriteLock } from './pr-write-lock.ts'
import { applyRepoIdentity } from './worktree.ts'

/** Replays only the observed PR head, validates it, and refuses concurrent remote edits. */
export async function rebasePr(opts: {
  root: string
  pr: PrInfo
  baseOid: string
  config: Config
  idle: () => boolean
  exec?: Exec
}): Promise<'rebased' | 'unchanged' | 'busy'> {
  return withPrWriteLock(opts.root, opts.config.forge.remote, opts.pr.headRefName, async () => {
    const run = opts.exec ?? defaultExec
    const { root, pr, baseOid, config } = opts
    if (!pr.headRefOid) return 'unchanged'
    if (!opts.idle()) return 'busy'
    const { remote, kind } = config.forge
    const auth = await gitTokenConfig(run, root, remote, forgeToken(kind, root))
    await execOk(
      run,
      [
        'git',
        'fetch',
        remote,
        `+refs/heads/${pr.headRefName}:refs/remotes/${remote}/${pr.headRefName}`,
      ],
      {
        cwd: root,
        env: auth,
      },
    )
    const head = (
      await execOk(run, ['git', 'rev-parse', `refs/remotes/${remote}/${pr.headRefName}`], {
        cwd: root,
      })
    ).trim()
    if (head !== pr.headRefOid) return 'unchanged'
    const contains = await run(['git', 'merge-base', '--is-ancestor', baseOid, head], { cwd: root })
    if (contains.exitCode === 0) return 'unchanged'
    if (contains.exitCode !== 1) throw new Error('cannot determine PR branch ancestry')
    const parent = mkdtempSync(join(tmpdir(), 'amagi-rebase-'))
    const path = join(parent, 'worktree')
    let added = false
    try {
      await execOk(run, ['git', 'worktree', 'add', '--detach', path, head], { cwd: root })
      added = true
      await applyRepoIdentity(run, path, root, config.repo.persona)
      const rebased = await run(['git', 'rebase', '--rebase-merges', baseOid], { cwd: path })
      if (rebased.exitCode !== 0) {
        await run(['git', 'rebase', '--abort'], { cwd: path })
        throw new Error(`rebase failed: ${(rebased.stderr || rebased.stdout).trim().slice(-2000)}`)
      }
      const diff = await run(['git', 'diff', '--quiet', baseOid, 'HEAD'], { cwd: path })
      if (diff.exitCode === 0) return 'unchanged'
      if (diff.exitCode !== 1) throw new Error('cannot inspect rebased PR diff')
      const commands = [
        config.repo.setupCmd,
        config.checks.format,
        config.checks.lint,
        ...config.checks.commands,
      ].filter((c): c is string => c !== null && c !== '')
      for (const command of commands) {
        await execOk(run, ['sh', '-c', command], { cwd: path })
      }
      if ((await execOk(run, ['git', 'status', '--porcelain'], { cwd: path })).trim()) {
        throw new Error('rebase checks modified the worktree; refusing to push')
      }
      await assertSafePushDestination(run, path, remote, pr.headRefName, auth)
      if (!opts.idle()) return 'busy'
      await execOk(
        run,
        [
          'git',
          'push',
          `--force-with-lease=refs/heads/${pr.headRefName}:${head}`,
          remote,
          `HEAD:refs/heads/${pr.headRefName}`,
        ],
        { cwd: path, env: auth },
      )
      return 'rebased'
    } finally {
      if (added) await execOk(run, ['git', 'worktree', 'remove', '--force', path], { cwd: root })
      rmSync(parent, { recursive: true, force: true })
    }
  })
}
