export const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type FailureOutcome = {
  stderr: string
  summary: string | null
  exitCode: number
}

/** Most useful agent failure detail: stderr, else the final summary, else the exit code. */
export const agentFailure = (o: FailureOutcome): string =>
  o.stderr.trim() || o.summary || `exit ${o.exitCode}`

/** Extracts the error field from a non-OK response, falling back to the HTTP status. */
export async function errorOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}
