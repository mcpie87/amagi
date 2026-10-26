import type { BeadsBlocker, BeadsIssue } from '@amagi/core/drivers/tracker/beads'
import { apiBase } from '../api.ts'

export type Issue = BeadsIssue & {
  /** Issues this one blocks; only the single-issue detail endpoint reports them. */
  dependents?: BeadsBlocker[]
}

/** Thrown by fetchIssue when the repo's tracker has no issue detail view (HTTP 501). */
export class IssueDetailUnsupported extends Error {}

/** One issue with its blockers and dependents, from the tracker's detail view. */
export async function fetchIssue(repo: string, id: string): Promise<Issue> {
  const res = await fetch(`${apiBase}/api/repos/${repo}/issues/${id}`)
  if (!res.ok) {
    const message = (await res.json()).error ?? `HTTP ${res.status}`
    throw res.status === 501 ? new IssueDetailUnsupported(message) : new Error(message)
  }
  return res.json() as Promise<Issue>
}
