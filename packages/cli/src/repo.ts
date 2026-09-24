import { join } from 'node:path'
import { openDatabase, repoName, repoRoot, Store, stateHome } from '@amagi/core'

export type CurrentRepo = {
  key: string
  root: string
  name: string
  store: Store
}

export function currentRepo(): CurrentRepo {
  const root = repoRoot()
  const name = repoName(root)
  const store = new Store(openDatabase(join(stateHome(), 'amagi', 'store.db')))
  return { key: name, root, name, store }
}
