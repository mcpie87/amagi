import {
  BeadsTracker,
  CAPABILITY_WORDS,
  errMsg,
  type Tracker,
  type TrackerCapabilities,
  type Workspace,
  type Workspaces,
} from '@amagi/core'
import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from 'zod'

/** Every validation failure uses the API's standard error response. */
export const valid = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: z.prettifyError(result.error) }, 400)
  })

/** The 501 reason for an operation the tracker cannot do, or null when it can. */
export function capabilityError(
  tracker: Tracker,
  capability: keyof TrackerCapabilities,
): string | null {
  return tracker.capabilities[capability]
    ? null
    : `${tracker.kind} tracker does not support ${CAPABILITY_WORDS[capability]}`
}

/** The beads tracker's issue browser and epic closer, or null for any other tracker. */
export function beadsTracker(ws: Workspace): BeadsTracker | null {
  return ws.tracker instanceof BeadsTracker ? ws.tracker : null
}

/** Thrown by repo resolution so handlers keep a single typed return. */
export class RepoError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

/** Resolves a repo param to its workspace, throwing a RepoError on failure. */
export function resolveWorkspace(workspaces: Workspaces, repo: string): Workspace {
  let ws: Workspace | null
  try {
    ws = workspaces.get(repo)
  } catch (err) {
    throw new RepoError(500, `repo ${repo}: ${errMsg(err)}`)
  }
  if (ws === null) throw new RepoError(404, `unknown repository ${repo}`)
  return ws
}
