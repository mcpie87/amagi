import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Exec } from './exec.ts'

const CHECK_TOOLING = /(?:^|\/)(?:justfile|bunfig\.toml|biome[^/]*\.jsonc?|tsconfig[^/]*\.json)$/i
const CHECK_SCRIPT = /^scripts\/lint-commits\.ts$/i
const PACKAGE_JSON = /(?:^|\/)package\.json$/i

function scripts(content: string | undefined): unknown {
  return content === undefined ? undefined : (JSON.parse(content) as { scripts?: unknown }).scripts
}

/** Check tooling changed since the task branched, including checkpoint commits. */
export async function changedCheckTooling(
  cwd: string,
  run: Exec,
  baseRef: string,
): Promise<string[]> {
  const common = await run(['git', 'merge-base', baseRef, 'HEAD'], { cwd })
  const base = common.stdout.trim()
  if (common.exitCode !== 0 || base === '') {
    throw new Error('could not resolve the task base for check tooling')
  }
  const [tracked, untracked, baseFiles] = await Promise.all([
    run(['git', 'diff', '--name-only', base], { cwd }),
    run(['git', 'ls-files', '--others', '--exclude-standard'], { cwd }),
    run(['git', 'ls-tree', '-r', '--name-only', base], { cwd }),
  ])
  if (tracked.exitCode !== 0 || untracked.exitCode !== 0 || baseFiles.exitCode !== 0) {
    throw new Error('could not inspect worktree changes for check tooling')
  }
  const existing = new Set(baseFiles.stdout.split('\n'))
  const changed = new Set<string>()
  for (const path of new Set(`${tracked.stdout}\n${untracked.stdout}`.split('\n'))) {
    if (path === '') continue
    if (CHECK_TOOLING.test(path) || CHECK_SCRIPT.test(path)) {
      changed.add(path)
      continue
    }
    if (!PACKAGE_JSON.test(path)) continue
    let before: string | undefined
    if (existing.has(path)) {
      const original = await run(['git', 'show', `${base}:${path}`], { cwd })
      if (original.exitCode !== 0)
        throw new Error(`could not inspect base check scripts in ${path}`)
      before = original.stdout
    }
    const current = join(cwd, path)
    if (
      !isDeepStrictEqual(
        scripts(before),
        scripts(existsSync(current) ? readFileSync(current, 'utf8') : undefined),
      )
    ) {
      changed.add(path)
    }
  }
  return [...changed].sort()
}
