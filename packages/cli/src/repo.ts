import { dirname, resolve } from 'node:path'
import {
  dbPathForRepo,
  findRegistryEntryByPath,
  openDatabase,
  repoKey,
  repoName,
  repoRoot,
  Store,
} from '@amagi/core'

export type CurrentRepo = {
  /** Registry key when registered, else the derived repo-name key. */
  key: string
  root: string
  name: string
  store: Store
}

/**
 * Resolves the repo the operator is standing in and opens its per-repo store,
 * so the CLI reads and writes the same data the server serves for that repo.
 */
export function currentRepo(): CurrentRepo {
  const worktreeRoot = repoRoot()
  const commonDir = Bun.spawnSync(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: worktreeRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  const root = process.env.AMAGI_REPO_ROOT
    ? resolve(process.env.AMAGI_REPO_ROOT)
    : commonDir.exitCode === 0
      ? dirname(resolve(worktreeRoot, commonDir.stdout.toString().trim()))
      : worktreeRoot
  const entry = findRegistryEntryByPath(root)
  const key = entry?.key ?? repoKey(root)
  return { key, root, name: repoName(root), store: new Store(openDatabase(dbPathForRepo(key))) }
}
