import type { Exec } from './exec.ts'

/** HEAD reflog as `<sha> <subject>` lines, newest first; null when unreadable. */
export async function headReflog(cwd: string, run: Exec): Promise<string[] | null> {
  try {
    const result = await run(['git', 'reflog', 'show', '--format=%H %gs', 'HEAD'], { cwd })
    if (result.exitCode !== 0) return null
    return result.stdout.split('\n').filter((line) => line !== '')
  } catch {
    return null
  }
}

/** New reflog entries since the snapshot, preserving newest-first order. */
export function headReflogEntriesSince(
  before: readonly string[],
  after: readonly string[],
): string[] {
  let commonTail = 0
  while (
    commonTail < before.length &&
    commonTail < after.length &&
    before[before.length - commonTail - 1] === after[after.length - commonTail - 1]
  ) {
    commonTail++
  }
  return after.slice(0, after.length - commonTail)
}

/** Run one agent and report unexpected HEAD reflog movement, best effort. */
export async function withHeadReflogBypassCheck<T>(
  cwd: string,
  run: Exec,
  action: () => Promise<T>,
  onBypassed?: (entries: string[]) => void,
  rejectBypass = false,
): Promise<T> {
  const before = await headReflog(cwd, run)
  if (rejectBypass && before === null) {
    throw new Error('cannot verify agent HEAD changes because its reflog is unavailable')
  }
  let result: T | undefined
  let actionError: unknown
  let actionFailed = false
  try {
    result = await action()
  } catch (err) {
    actionFailed = true
    actionError = err
  }
  let bypassed = false
  let reflogUnavailable = false
  if (before !== null) {
    const after = await headReflog(cwd, run)
    if (after === null) {
      reflogUnavailable = true
    } else {
      const entries = headReflogEntriesSince(before, after)
      if (entries.length > 0) {
        bypassed = true
        if (onBypassed !== undefined) {
          try {
            onBypassed(entries)
          } catch {
            // Observability must not fail the agent run.
          }
        }
      }
    }
  }
  if (actionFailed) throw actionError
  if (rejectBypass && reflogUnavailable) {
    throw new Error('cannot verify agent HEAD changes because its reflog is unavailable')
  }
  if (rejectBypass && bypassed) {
    throw new Error('agent changed HEAD outside the amagi commit path')
  }
  return result as T
}
