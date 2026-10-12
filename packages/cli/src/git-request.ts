import { errorOf } from '@amagi/core'

export type GitRequestOptions = {
  baseUrl: string
  repo: string
  taskId: string
  token: string
  verb: GitRequestVerb
  message?: string
}

/** The closed set the server accepts; anything else is refused before a request is made. */
export const GIT_REQUEST_VERBS = ['commit', 'merge-base', 'pr', 'push', 'comment', 'close'] as const
export type GitRequestVerb = (typeof GIT_REQUEST_VERBS)[number]

export function isGitRequestVerb(verb: string): verb is GitRequestVerb {
  return (GIT_REQUEST_VERBS as readonly string[]).includes(verb)
}

export { taskIdFromAmagiBranch as taskIdFromBranch } from '@amagi/core'

/**
 * Requests a sanctioned git write from the orchestrator and returns what it
 * did: the commit sha, or the orchestrator's account of the request. Any
 * failure (no server, a rejected verb, a git error) throws so the agent
 * learns immediately.
 */
export async function requestGitWrite(opts: GitRequestOptions): Promise<string> {
  const res = await fetch(
    `${opts.baseUrl}/api/repos/${opts.repo}/tasks/${opts.taskId}/git-requests`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Amagi-Token': opts.token },
      body: JSON.stringify({
        verb: opts.verb,
        ...(opts.message === undefined ? {} : { message: opts.message }),
      }),
    },
  )
  if (!res.ok) throw new Error(`amagi git-request: ${await errorOf(res)}`)
  const body = (await res.json()) as { sha?: string; result?: string }
  return body.sha ?? body.result ?? ''
}
