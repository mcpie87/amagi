import {
  classifyDifficulty,
  type TrackerTask,
  type UpdateTrackerTask,
  type Workspaces,
} from '@amagi/core'
import { Hono } from 'hono'
import { beadsTracker, capabilityError, resolveWorkspace, valid } from './route-utils.ts'
import {
  EpicCloseBody,
  IssueCreateBody,
  IssueUpdateBody,
  RepoParam,
  RepoTaskIdParam,
} from './schemas.ts'

export function createIssueRoutes(workspaces: Workspaces) {
  return new Hono()
    .get('/api/repos/:repo/issues/:id', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const beads = beadsTracker(ws)
      if (beads === null) {
        return c.json({ error: `issue detail is unavailable for ${repo}` }, 501)
      }
      const issue = await beads.getIssue(id)
      if (issue === null) return c.json({ error: `unknown issue ${id}` }, 404)
      return c.json({ ...issue, dependents: await beads.dependents(id) })
    })
    .get('/api/repos/:repo/issues/:id/children', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const beads = beadsTracker(ws)
      if (beads === null) {
        return c.json({ error: `issue details are unavailable for ${repo}` }, 501)
      }
      return c.json(await beads.children(id))
    })
    .post(
      '/api/repos/:repo/issues/:id/close',
      valid('param', RepoTaskIdParam),
      valid('json', EpicCloseBody),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const { reason } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        if (beadsTracker(ws) === null) {
          return c.json({ error: `issue closure is unavailable for ${repo}` }, 501)
        }
        await ws.tracker.close(id, reason)
        return c.json({ id, status: 'closed', reason })
      },
    )
    .post(
      '/api/repos/:repo/issues',
      valid('param', RepoParam),
      valid('json', IssueCreateBody),
      async (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const cap = capabilityError(ws.tracker, 'create')
        if (cap !== null) return c.json({ error: cap }, 501)
        const body = c.req.valid('json')
        const input = ws.config.difficulty.enabled
          ? {
              ...body,
              difficulty: await classifyDifficulty(body.title, body.description, ws.config),
            }
          : body
        const created: TrackerTask = await ws.tracker.createTask(input)
        const beads = beadsTracker(ws)
        const issue = beads === null ? null : await beads.getIssue(created.id)
        return c.json(issue ?? created, 201)
      },
    )
    .patch(
      '/api/repos/:repo/issues/:id',
      valid('param', RepoTaskIdParam),
      valid('json', IssueUpdateBody),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const body = c.req.valid('json')
        const input: UpdateTrackerTask = {
          title: body.title,
          description: body.description,
          acceptanceCriteria: body.acceptanceCriteria,
          priority: body.priority,
          labels: body.labels,
        }
        const hasEditFields =
          input.title !== undefined ||
          input.description !== undefined ||
          input.acceptanceCriteria !== undefined ||
          input.priority !== undefined ||
          input.labels !== undefined
        if (hasEditFields) {
          const editCap = capabilityError(ws.tracker, 'edit')
          if (editCap !== null) return c.json({ error: editCap }, 501)
        }
        if (body.dependencies !== undefined) {
          const depCap = capabilityError(ws.tracker, 'dependencies')
          if (depCap !== null) return c.json({ error: depCap }, 501)
          const beads = beadsTracker(ws)
          if (beads === null) {
            return c.json({ error: 'cannot resolve dependency changes without issue detail' }, 501)
          }
          const current = (await beads.getIssue(id))?.dependencies.map((d) => d.id) ?? []
          input.dependencies = {
            add: body.dependencies.filter((d) => !current.includes(d)),
            remove: current.filter((d) => !body.dependencies?.includes(d)),
          }
        }
        const updated = await ws.tracker.updateTask(id, input)
        const beads = beadsTracker(ws)
        const issue = beads === null ? null : await beads.getIssue(updated.id)
        return c.json(issue ?? updated)
      },
    )
    .get('/api/repos/:repo/issues', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const beads = beadsTracker(ws)
      if (beads === null) {
        return c.json({ error: `issue browser is unavailable for ${repo}` }, 501)
      }
      return c.json(await beads.list())
    })
    .get('/api/repos/:repo/epics/close-eligible', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const beads = beadsTracker(ws)
      if (beads === null) {
        return c.json({ error: `epic closure is unavailable for ${repo}` }, 501)
      }
      return c.json(await beads.eligibleEpics())
    })
    .post(
      '/api/repos/:repo/epics/close-eligible',
      valid('param', RepoParam),
      valid('json', EpicCloseBody),
      async (c) => {
        const { repo } = c.req.valid('param')
        const { reason } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const beads = beadsTracker(ws)
        if (beads === null) {
          return c.json({ error: `epic closure is unavailable for ${repo}` }, 501)
        }
        return c.json(await beads.closeEligibleEpics(reason))
      },
    )
}
