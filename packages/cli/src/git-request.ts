import { errorOf } from '@amagi/core'

export type GitRequestOptions = {
  baseUrl: string
  taskId: string
  token: string
  verb: 'commit'
}

export { taskIdFromAmagiBranch as taskIdFromBranch } from '@amagi/core'

/**
 * Requests a sanctioned git write from the orchestrator and returns the
 * resulting commit sha. Any failure (no server, a rejected verb, a git error)
 * throws so the agent learns immediately.
 */
export async function requestGitWrite(opts: GitRequestOptions): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/api/tasks/${opts.taskId}/git-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Amagi-Token': opts.token },
    body: JSON.stringify({ verb: opts.verb }),
  })
  if (!res.ok) throw new Error(`amagi git-request: ${await errorOf(res)}`)
  const body = (await res.json()) as { sha: string }
  return body.sha
}
