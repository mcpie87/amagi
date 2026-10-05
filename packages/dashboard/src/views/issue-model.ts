import { apiBase } from '../api.ts'

export type Dependency = {
  id: string
  title: string
  /** Tracker status of the blocker: open/in_progress/blocked/closed. */
  status: string
  /** Human-only blockers carry the `human` label and need an operator, not an agent. */
  labels: string[]
}

export type Issue = {
  id: string
  title: string
  description: string
  acceptanceCriteria: string | null
  status: 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number | null
  url?: string | null
  type: string | null
  assignee: string | null
  labels: string[]
  parent: string | null
  dependencies: Dependency[]
  /** Issues this one blocks; only the single-issue detail endpoint reports them. */
  dependents?: Dependency[]
}

/** One issue with its blockers and dependents, from the tracker's detail view. */
export async function fetchIssue(repo: string, id: string): Promise<Issue> {
  const res = await fetch(`${apiBase}/api/repos/${repo}/issues/${id}`)
  if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
  return res.json() as Promise<Issue>
}
