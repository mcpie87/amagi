import type { Exec } from '../exec.ts'
import { execOk } from '../exec.ts'

/** Refuses pushes that would update a conventional or configured default branch. */
export async function assertSafePushDestination(
  exec: Exec,
  cwd: string,
  remote: string,
  destination: string,
  auth: Record<string, string> = {},
): Promise<void> {
  const branch = destination.replace(/^refs\/heads\//, '')
  if (branch === 'main' || branch === 'master') {
    throw new Error(`refusing to push to protected branch ${branch}`)
  }

  const pushUrls = (
    await execOk(exec, ['git', 'remote', 'get-url', '--push', '--all', remote], { cwd })
  )
    .split('\n')
    .filter(Boolean)
  if (pushUrls.length === 0) {
    throw new Error(`cannot determine push URLs for remote ${remote}; refusing to push`)
  }

  for (const url of pushUrls) {
    const output = await execOk(exec, ['git', 'ls-remote', '--symref', url, 'HEAD'], {
      cwd,
      env: auth,
    })
    const defaultRef = output.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1]
    if (defaultRef === undefined) {
      throw new Error(`cannot determine default branch for remote ${remote}; refusing to push`)
    }
    if (branch === defaultRef) {
      throw new Error(`refusing to push to remote default branch ${branch}`)
    }
  }
}
