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
  const root = repoRoot()
  const entry = findRegistryEntryByPath(root)
  const key = entry?.key ?? repoKey(root)
  return { key, root, name: repoName(root), store: new Store(openDatabase(dbPathForRepo(key))) }
}
