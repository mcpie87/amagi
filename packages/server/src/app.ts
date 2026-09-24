import {
  BeadsTracker,
  CAPABILITY_WORDS,
  ChatService,
  Config,
  canReset,
  classifyDifficulty,
  errMsg,
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  HUMAN_ONLY_LABEL,
  hasStaleMaxParallel,
  isTerminal,
  type LiveRun,
  loadGlobalConfig,
  makeHarness,
  mergeLiveRuns,
  type Notifier,
  newWorkerId,
  type Question,
  type RegistryEntry,
  Runner,
  type RunServiceApi,
  reconcilePr,
  removeWorktree,
  type Store,
  type StoredEvent,
  type Tracker,
  type TrackerCapabilities,
  type TrackerTask,
  Triage,
  type UpdateTrackerTask,
  type WorkerActivity,
  WorkerConfig,
  type Workspace,
  type Workspaces,
  writeConfig,
  writeGlobalConfig,
} from '@amagi/core'
import type { Harness } from '@amagi/core/drivers/types'
import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import * as z from 'zod'
import {
  AnswerBody,
  AskBody,
  AwaitQuery,
  ChatBody,
  CloseTaskBody,
  EpicCloseBody,
  EventQuery,
  GitRequestBody,
  IssueCreateBody,
  IssueUpdateBody,
  ParticipationBody,
  QuestionQuery,
  RepoParam,
  RepoQuestionParam,
  RepoRegisterBody,
  RepoTaskIdParam,
  RunBody,
  SettingsBody,
  StreamQuery,
  TaskIdParam,
  TaskListQuery,
  WatcherParam,
  WatcherUpdateBody,
  WorkerCreateBody,
  WorkerUpdateBody,
} from './schemas.ts'
import { eventStream } from './stream.ts'

export type ServerDeps = {
  workspaces: Workspaces
  notify?: Notifier[] | undefined
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi | undefined
  /** The repo key the runner is bound to, so settings apply live only to it. */
  runnerRepo?: string | undefined
  /** Background worker activity (e.g. mention watchers), merged into /api/runner. */
  workers?: () => WorkerActivity[]
  /** Foreground CLI workers (`just run`) outside the server runner, merged into /api/runner. */
  liveRuns?: () => LiveRun[]
  /** Overridable so tests stub the harness a workspace's chat uses. */
  chatHarnessFor?: (ws: Workspace) => Harness
}

/**
 * Every failure on the API answers with the same `{ error }` shape, so the
 * hono/client response union stays one success type plus one error type.
 */
const valid = <T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) return c.json({ error: z.prettifyError(result.error) }, 400)
  })

/** The 501 reason for an operation the tracker cannot do, or null when it can. */
function capabilityError(tracker: Tracker, capability: keyof TrackerCapabilities): string | null {
  return tracker.capabilities[capability]
    ? null
    : `${tracker.kind} tracker does not support ${CAPABILITY_WORDS[capability]}`
}

/** The beads tracker's issue browser and epic closer, or null for any other tracker. */
function beadsTracker(ws: Workspace): BeadsTracker | null {
  return ws.tracker instanceof BeadsTracker ? ws.tracker : null
}

/**
 * The agent carries AMAGI_TASK_TOKEN in its environment; a question is bound
 * to the task that spawned it, so one agent cannot answer for another.
 */
const authorized = (c: Context, store: Store, id: string): boolean =>
  c.req.header('X-Amagi-Token') === store.token(id)

/**
 * Best effort: a notifier (e.g. a missing notify-send) must never break the
 * ask request, so failures are logged and still recorded as notify.sent so
 * the dashboard shows what was attempted.
 */
async function notifyChannels(
  notifiers: Notifier[],
  store: Store,
  title: string,
  body: string,
): Promise<void> {
  for (const notifier of notifiers) {
    try {
      await notifier.notify(title, body)
    } catch (err) {
      console.warn(`notify ${notifier.kind}: ${errMsg(err)}`)
    }
    store.append(null, { type: 'notify.sent', channel: notifier.kind, title })
  }
}

/**
 * A gate is a courtesy, not a prerequisite: if the tracker cannot open one the
 * question still lands in the store and the notifiers still fire, so the agent
 * is never stranded by a tracker hiccup.
 */
async function openQuestionGate(
  tracker: Tracker | undefined,
  taskId: string,
  question: Question,
): Promise<string | null> {
  if (tracker === undefined) return null
  try {
    return (await tracker.openGate(taskId, question)).id
  } catch (err) {
    console.warn(`openGate ${taskId}: ${errMsg(err)}`)
    return null
  }
}

async function resolveQuestionGate(
  tracker: Tracker | undefined,
  gateRef: string | null,
): Promise<void> {
  if (tracker === undefined || gateRef === null) return
  try {
    await tracker.resolveGate({ id: gateRef, advisory: false })
  } catch (err) {
    console.warn(`resolveGate ${gateRef}: ${errMsg(err)}`)
  }
}

/** Thrown by repo resolution so handlers keep a single typed return. */
class RepoError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message)
    this.name = 'RepoError'
  }
}

/** Resolves a repo param to its workspace, throwing a RepoError on failure. */
function resolveWorkspace(workspaces: Workspaces, repo: string): Workspace {
  let ws: Workspace | null
  try {
    ws = workspaces.get(repo)
  } catch (err) {
    throw new RepoError(500, `repo ${repo}: ${errMsg(err)}`)
  }
  if (ws === null) throw new RepoError(404, `unknown repository ${repo}`)
  return ws
}

export function createApp({
  workspaces,
  notify = [],
  runner,
  runnerRepo,
  workers,
  liveRuns,
  chatHarnessFor,
}: ServerDeps) {
  // One ChatService per workspace, so the in-flight guard survives requests.
  const chats = new Map<string, ChatService>()
  const chatFor = (ws: Workspace): ChatService => {
    let chat = chats.get(ws.key)
    if (chat === undefined) {
      const harness = chatHarnessFor?.(ws) ?? makeHarness(ws.config.harness.implement)
      chat = new ChatService({ store: ws.store, harness, config: ws.config })
      chats.set(ws.key, chat)
    }
    return chat
  }
  // The legacy non-scoped stop route predates the repo registry; it targets the
  // first registered workspace, which is the default repo for single-repo use.
  const defaultStore = (): Store | null => {
    const entry = workspaces.list()[0]
    return entry === undefined ? null : (workspaces.get(entry.key)?.store ?? null)
  }
  // The global config on disk is the fleet's truth; the served runner reads its
  // own workspace's copy, so a save has to replace that copy too to live-apply.
  const saveFleet = (fleet: WorkerConfig[]): void => {
    writeGlobalConfig({ worker: fleet })
    if (runnerRepo !== undefined) resolveWorkspace(workspaces, runnerRepo).config.worker = fleet
  }
  const fleetView = async () => {
    const live = runner === undefined ? [] : ((await runner.status()).fleet ?? [])
    return loadGlobalConfig().worker.map((worker) => {
      const state = live.find((w) => w.id === worker.id)
      return { ...worker, on: state?.on ?? false, taskId: state?.taskId ?? null }
    })
  }
  return new Hono()

    .get('/api/health', (c) => c.json({ ok: true }))

    .get('/api/usage-rates', (c) => {
      const windowMs = 60_000
      const since = Date.now() - windowMs
      const groups = new Map<string, { seat: string; calls: number; tokens: number }>()
      for (const entry of workspaces.list()) {
        const ws = workspaces.get(entry.key)
        if (ws === null) continue
        for (const event of ws.store.eventsSince(since)) {
          if (event.type !== 'agent.stream' || event.event.kind !== 'usage') continue
          const seat = event.event.seat ?? 'Unassigned / seat not recorded'
          const group = groups.get(seat) ?? { seat, calls: 0, tokens: 0 }
          group.calls++
          group.tokens += event.event.inputTokens + event.event.outputTokens
          groups.set(seat, group)
        }
      }
      return c.json({ windowSeconds: 60, rates: [...groups.values()] })
    })

    .get('/api/repos', async (c) => {
      const out = []
      for (const entry of workspaces.list()) {
        try {
          const ready = await workspaces.diagnose(entry)
          out.push({
            key: entry.key,
            name: entry.name,
            path: entry.path,
            workers: entry.workers,
            watchers: entry.watchers,
            ready,
          })
        } catch (err) {
          out.push({
            key: entry.key,
            name: entry.name,
            path: entry.path,
            workers: entry.workers,
            watchers: entry.watchers,
            ready: [
              {
                name: 'workspace',
                ok: false,
                detail: errMsg(err),
              },
            ],
          })
        }
      }
      return c.json(out)
    })

    .post('/api/repos', valid('json', RepoRegisterBody), async (c) => {
      const { path, key } = c.req.valid('json')
      let entry: RegistryEntry
      try {
        entry = workspaces.add(path, key)
      } catch (err) {
        return c.json({ error: errMsg(err) }, 400)
      }
      const ready = await workspaces.diagnose(entry)
      return c.json({ ...entry, ready }, 201)
    })

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
        // Only the operation actually requested is gated, so a dependency-only
        // edit reports the dependency gap rather than a generic edit gap.
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
        // The board edits dependencies as a full set; the tracker wants a diff.
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

    .delete('/api/repos/:repo', valid('param', RepoParam), (c) => {
      if (!workspaces.remove(c.req.valid('param').repo)) {
        return c.json({ error: `unknown repository ${c.req.valid('param').repo}` }, 404)
      }
      return c.json({ ok: true })
    })

    .get('/api/repos/:repo/ready', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const entry = workspaces.list().find((e) => e.key === repo)
      if (!entry) return c.json({ error: `unknown repository ${repo}` }, 404)
      return c.json(await workspaces.diagnose(entry))
    })

    .get('/api/repos/:repo/ready-queue', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      // The tracker orders the queue FCFS (bd ready --sort oldest).
      return c.json(await ws.tracker.ready())
    })

    .get('/api/repos/:repo/mergeable-prs', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      if (ws.forge === null) {
        return c.json({ error: `forge driver unavailable for ${repo}` }, 501)
      }
      // The driver reports the forge's own flags (gh wording on both drivers),
      // so one filter is all it takes to find the PRs that can merge now.
      const open = await ws.forge.listOpenPrs(ws.root)
      return c.json({
        prs: open.filter((p) => p.mergeable === 'MERGEABLE' || p.mergeStateStatus === 'CLEAN'),
      })
    })

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

    .post('/api/tasks/:id/stop', valid('param', TaskIdParam), (c) => {
      const store = defaultStore()
      if (store === null) return c.json({ error: 'no repository registered' }, 409)
      const { id } = c.req.valid('param')
      const task = store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      if (isTerminal(task.state)) {
        return c.json({ error: `task ${id} is already in terminal state ${task.state}` }, 409)
      }
      // Park the run in `cancelled`; a live runner watches the store, kills
      // the agent process and unwinds. A crashed runner leaves the task parked
      // for the operator to reclaim via the restart flow.
      store.append(id, {
        type: 'task.state',
        from: task.state,
        to: 'cancelled',
        reason: 'operator interrupt',
      })
      return c.json({ task: store.task(id) })
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

    .get(
      '/api/repos/:repo/tasks',
      valid('param', RepoParam),
      valid('query', TaskListQuery),
      (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { state, limit } = c.req.valid('query')
        return c.json(ws.store.tasks(state ? { states: state, limit } : { limit }))
      },
    )

    .get('/api/repos/:repo/tasks/:id', valid('param', RepoTaskIdParam), (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      // The dashboard answers via the token-bound endpoint but has no other
      // channel for the credential, so the task detail doubles as its source.
      return c.json({ task, token: ws.store.token(id), questions: ws.store.openQuestions(id) })
    })

    .post('/api/repos/:repo/tasks/:id/reclaim', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      // A completed or abandoned run cannot come back: the tracker issue is
      // closed and the runner will never claim it again. Everything else is
      // restartable — the runner resumes the recorded worktree when present
      // and starts from a fresh worktree otherwise.
      if (task.state === 'done' || task.state === 'abandoned') {
        return c.json({ error: `task ${id} is in terminal state ${task.state}` }, 409)
      }
      // Best effort: the runner only re-claims issues the tracker sees as
      // ready, so a lapsed or still-live claim is released for it to pick up.
      try {
        await ws.tracker.release(id)
      } catch (err) {
        console.warn(`release ${id}: ${errMsg(err)}`)
      }
      ws.store.append(id, { type: 'task.reclaimed' })
      return c.json({ task: ws.store.task(id) })
    })

    .post('/api/repos/:repo/tasks/:id/reset', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      if (!canReset(task.state, task.worktree !== null)) {
        return c.json({ error: `task ${id} cannot be reset from state ${task.state}` }, 409)
      }
      if (runner !== undefined) {
        try {
          await runner.stop(id)
        } catch (err) {
          console.warn(`stop on reset ${id}: ${errMsg(err)}`)
        }
      }
      // Unlike close, the worktree removal is not best effort: a surviving
      // worktree or branch would be resumed by the next run, which is exactly
      // what the reset promises not to do.
      if (task.worktree !== null) {
        try {
          await removeWorktree(ws.store, id, {
            repoRoot: ws.root,
            path: task.worktree,
            branch: task.branch ?? null,
          })
        } catch (err) {
          return c.json({ error: `failed to remove worktree: ${errMsg(err)}` }, 500)
        }
      }
      try {
        await ws.tracker.release(id)
      } catch (err) {
        console.warn(`release on reset ${id}: ${errMsg(err)}`)
      }
      ws.store.append(id, { type: 'task.reset', reason: 'operator reset' })
      return c.json({ task: ws.store.task(id) })
    })

    .post('/api/repos/:repo/tasks/:id/retry', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      // The runner's backoff only reacts to a wake-up while the task is
      // actually deferring a retry; anything else would mislead the operator.
      if (task.state !== 'retrying') {
        return c.json({ error: `task ${id} is not deferring a retry` }, 409)
      }
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const result = await runner.retryNow(id)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json({ taskId: result.taskId })
    })

    .post('/api/repos/:repo/tasks/:id/recheck', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      // Only a task parked on its pull request has anything to re-check; the
      // sweep these states otherwise wait for is what this endpoint short-cuts.
      if (task.state !== 'pr_open' && task.state !== 'pr_flagged') {
        return c.json(
          { error: `task ${id} is not waiting on a pull request (state ${task.state})` },
          409,
        )
      }
      if (task.prNumber === null) {
        return c.json({ error: `task ${id} has no recorded pull request number` }, 409)
      }
      if (ws.forge === null) {
        return c.json({ error: `forge driver unavailable for ${repo}` }, 501)
      }
      // The reconcile writes events the dashboard already streams, so the
      // caller's live state picks up a merge/close without a page reload.
      await reconcilePr(ws.store, ws.forge, ws.tracker, ws.root, ws.config.forge.remote, task)
      return c.json({ task: ws.store.task(id) })
    })

    .post(
      '/api/repos/:repo/tasks/:id/filed-as-error',
      valid('param', RepoTaskIdParam),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        // The error-task retry path applies to a task parked for attention with
        // an error to carry; a bare park (e.g. no_pr) has nothing to rerun from.
        if (task.state !== 'needs_human') {
          return c.json({ error: `task ${id} is not waiting for human attention` }, 409)
        }
        const reason = task.statusReason
        if (reason === null || reason.trim() === '') {
          return c.json({ error: `task ${id} has no recorded error to file` }, 409)
        }
        const createCap = capabilityError(ws.tracker, 'create')
        if (createCap !== null) return c.json({ error: createCap }, 501)
        const depCap = capabilityError(ws.tracker, 'dependencies')
        if (depCap !== null) return c.json({ error: depCap }, 501)
        // The same failure on the same task must not stack a second error bead:
        // filing twice (a repeated recovery, a double-click) reuses the open
        // error task already recorded for this exact reason.
        const prior = ws.store
          .events({ taskId: id })
          .filter(
            (e): e is Extract<StoredEvent, { type: 'retry.filed_as_error' }> =>
              e.type === 'retry.filed_as_error',
          )
          .findLast((e) => e.reason === reason)
        const priorTask = prior === undefined ? null : await ws.tracker.get(prior.errorTaskId)
        const errorTask =
          priorTask !== null && priorTask.status !== 'closed'
            ? priorTask
            : await ws.tracker.createTask({
                title: `Error: ${task.title}`,
                description:
                  `The task ${id} errored out while the agent was implementing it.\n\n` +
                  `${reason}\n\n` +
                  `Resolve this task to rerun ${id} once its root cause is fixed.`,
                acceptanceCriteria: null,
                priority: null,
                // The error task is the operator's to resolve, not the agent's.
                labels: [HUMAN_ONLY_LABEL],
                dependencies: [],
                parent: null,
              })
        // The original blocks on the error task, so the runner skips it until
        // the error task resolves, then reruns it from its preserved worktree.
        await ws.tracker.updateTask(id, { dependencies: { add: [errorTask.id], remove: [] } })
        // Best effort: release the tracker claim so the unblocked task re-enters
        // the ready queue once the error task is closed and the auto-pick loop
        // reruns it. A hiccup here only delays the rerun, never loses the work.
        try {
          await ws.tracker.release(id)
        } catch (err) {
          console.warn(
            `release on filed-as-error ${id}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        ws.store.append(id, {
          type: 'retry.filed_as_error',
          errorTaskId: errorTask.id,
          reason,
        })
        return c.json({ task: ws.store.task(id), errorTask })
      },
    )

    .post(
      '/api/repos/:repo/tasks/:id/close',
      valid('param', RepoTaskIdParam),
      valid('json', CloseTaskBody),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const { reason, to } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        // Instant close retires any in-flight or parked task; only a task
        // already settled (done/abandoned) has nothing left to close.
        if (
          isTerminal(task.state) &&
          task.state !== 'needs_human' &&
          task.state !== 'no_pr' &&
          task.state !== 'cancelled'
        ) {
          return c.json({ error: `task ${id} cannot be closed from state ${task.state}` }, 409)
        }
        // Only a parked no_pr/needs_human task can be marked done: the agent
        // left no changes because the work was already satisfied.
        if (to === 'done' && task.state !== 'needs_human' && task.state !== 'no_pr') {
          return c.json({ error: `task ${id} cannot be marked done from state ${task.state}` }, 409)
        }
        // Closing a pr_flagged task retires its pointless pull request too: the
        // watcher parked it because the diff is empty and a human is the only
        // one who closes it. This is the one step that must not be best effort,
        // else the task retires with the PR still open on the forge.
        if (task.state === 'pr_flagged') {
          if (ws.forge === null) {
            return c.json(
              {
                error: `task ${id} is pr_flagged but no forge driver is available to close its PR`,
              },
              501,
            )
          }
          if (task.prNumber === null) {
            return c.json({ error: `task ${id} is pr_flagged without a pull request number` }, 409)
          }
          try {
            await ws.forge.closePr(ws.root, task.prNumber, reason)
          } catch (err) {
            return c.json({ error: `failed to close pull request: ${errMsg(err)}` }, 502)
          }
        }
        // Shut the worker down first: stop() kills the owned agent process and
        // parks a live run in cancelled, releasing the tracker claim, so the
        // close below retires it without racing the run. A task not running on
        // this server's runner (CLI run, another server) is simply not stopped.
        if (runner !== undefined) {
          try {
            await runner.stop(id)
          } catch (err) {
            console.warn(`stop on close ${id}: ${errMsg(err)}`)
          }
        }
        const afterStop = ws.store.task(id)
        ws.store.append(id, {
          type: 'task.state',
          from: afterStop?.state ?? task.state,
          to,
          reason,
        })
        // Best effort like reconcile: the store is authoritative, so a git or
        // tracker hiccup logs the failure instead of losing the operator's close.
        if (afterStop !== null && afterStop.worktree !== null) {
          const { worktree, branch } = afterStop
          try {
            await removeWorktree(ws.store, id, {
              repoRoot: ws.root,
              path: worktree,
              branch: branch ?? null,
            })
          } catch (err) {
            console.warn(`worktree removal on close ${id}: ${errMsg(err)}`)
          }
        }
        try {
          await ws.tracker.close(id, reason)
        } catch (err) {
          console.warn(`close ${id}: ${errMsg(err)}`)
        }
        if (task.state === 'pr_flagged' && ws.forge !== null && task.branch !== null) {
          try {
            await ws.forge.deleteBranch(ws.root, ws.config.forge.remote, task.branch)
          } catch (err) {
            console.warn(`branch removal on close ${id}: ${errMsg(err)}`)
          }
        }
        return c.json({ task: ws.store.task(id) })
      },
    )

    .post(
      '/api/repos/:repo/tasks/:id/chat',
      valid('param', RepoTaskIdParam),
      valid('json', ChatBody),
      (c) => {
        const { repo, id } = c.req.valid('param')
        const { message } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const result = chatFor(ws).send(id, message)
        if (!result.ok) return c.json({ error: result.error }, result.status)
        // The answer streams back through the repo event stream like any agent
        // run, so the request returns before the run finishes.
        return c.json({ taskId: id }, 202)
      },
    )

    .get('/api/runner', async (c) => {
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      let status = await runner.status()
      if (liveRuns !== undefined) status = await mergeLiveRuns(status, liveRuns())
      if (workers === undefined) return c.json(status)
      return c.json({ ...status, workers: workers() })
    })

    .get('/api/runner/options', (c) => {
      if (runner === undefined || runnerRepo === undefined) {
        return c.json({ harnesses: [], models: {}, efforts: {}, default: null })
      }
      const ws = resolveWorkspace(workspaces, runnerRepo)
      return c.json({
        harnesses: ws.config.worker.map((worker) => ({
          name: worker.name,
          workerId: worker.id,
          kind: worker.kind,
          ...(worker.model === undefined ? {} : { model: worker.model }),
          ...(worker.effort === undefined ? {} : { effort: worker.effort }),
        })),
        models: HARDCODED_MODELS,
        efforts: HARDCODED_EFFORTS,
        default: ws.config.worker.find((worker) => worker.enabled)?.id ?? null,
      })
    })

    .get('/api/repos/:repo/settings', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      return c.json({
        autoQueue: ws.config.loop.autoQueue,
        staleMaxParallel: hasStaleMaxParallel(ws.root),
      })
    })

    .patch(
      '/api/repos/:repo/settings',
      valid('param', RepoParam),
      valid('json', SettingsBody),
      (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { autoQueue } = c.req.valid('json')
        writeConfig(ws.root, { loop: { autoQueue } })
        if (autoQueue !== undefined) {
          ws.config.loop.autoQueue = autoQueue
          if (runner !== undefined && runnerRepo === repo) {
            const workersEnabled =
              workspaces.list().find((entry) => entry.key === repo)?.workers === true
            runner.setAutoQueue(autoQueue && workersEnabled)
          }
        }
        return c.json({ autoQueue: ws.config.loop.autoQueue })
      },
    )

    .patch(
      '/api/repos/:repo/participation',
      valid('param', RepoParam),
      valid('json', ParticipationBody),
      (c) => {
        const { repo } = c.req.valid('param')
        const body = c.req.valid('json')
        const participation = {
          ...(body.workers === undefined ? {} : { workers: body.workers }),
          ...(body.watchers === undefined ? {} : { watchers: body.watchers }),
        }
        if (!workspaces.updateParticipation(repo, participation)) {
          return c.json({ error: `unknown repository ${repo}` }, 404)
        }
        if (body.workers !== undefined && runner !== undefined && runnerRepo === repo) {
          runner.setAutoQueue(
            resolveWorkspace(workspaces, repo).config.loop.autoQueue && body.workers,
          )
        }
        const entry = workspaces.list().find((e) => e.key === repo)
        return c.json({ workers: entry?.workers ?? false, watchers: entry?.watchers ?? false })
      },
    )

    .get('/api/workers', async (c) => c.json({ workers: await fleetView() }))

    .post('/api/workers', valid('json', WorkerCreateBody), async (c) => {
      const fleet = loadGlobalConfig().worker
      const worker = WorkerConfig.parse({
        id: newWorkerId(fleet.map((w) => w.id)),
        ...c.req.valid('json'),
      })
      const next = Config.shape.worker.safeParse([...fleet, worker])
      if (!next.success) return c.json({ error: z.prettifyError(next.error) }, 400)
      saveFleet(next.data)
      return c.json({ ...worker, on: false, taskId: null }, 201)
    })

    .patch(
      '/api/workers/:id',
      valid('param', TaskIdParam),
      valid('json', WorkerUpdateBody),
      async (c) => {
        const { id } = c.req.valid('param')
        const { on, ...fields } = c.req.valid('json')
        const fleet = loadGlobalConfig().worker
        const current = fleet.find((w) => w.id === id)
        if (current === undefined) return c.json({ error: `unknown worker ${id}` }, 404)
        if (on !== undefined && runner === undefined) {
          return c.json({ error: 'runner service is unavailable' }, 501)
        }
        const merged: Record<string, unknown> = { ...current }
        for (const [key, value] of Object.entries(fields)) {
          if (value === null) delete merged[key]
          else if (value !== undefined) merged[key] = value
        }
        const parsed = WorkerConfig.safeParse(merged)
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)
        const worker = parsed.data
        if (on === true && !worker.enabled) {
          return c.json({ error: `worker ${id} is disabled; enable it before turning it on` }, 409)
        }
        // setWorkerOn ignores a disabled worker, so it has to go off before the save disables it.
        if (!worker.enabled) runner?.setWorkerOn(id, false)
        if (Object.keys(fields).length > 0) saveFleet(fleet.map((w) => (w.id === id ? worker : w)))
        if (on !== undefined) runner?.setWorkerOn(id, on)
        return c.json((await fleetView()).find((w) => w.id === id))
      },
    )

    .delete('/api/workers/:id', valid('param', TaskIdParam), async (c) => {
      const { id } = c.req.valid('param')
      const fleet = loadGlobalConfig().worker
      if (!fleet.some((w) => w.id === id)) return c.json({ error: `unknown worker ${id}` }, 404)
      const running = (await fleetView()).find((w) => w.id === id)?.taskId ?? null
      if (running !== null) {
        return c.json(
          { error: `worker ${id} is running ${running}; stop that run before deleting the worker` },
          409,
        )
      }
      saveFleet(fleet.filter((w) => w.id !== id))
      return c.json({ id })
    })

    .get('/api/watchers', (c) => c.json(loadGlobalConfig().watchers))

    .patch(
      '/api/watchers/:kind',
      valid('param', WatcherParam),
      valid('json', WatcherUpdateBody),
      (c) => {
        const { kind } = c.req.valid('param')
        const patch = c.req.valid('json')
        if (kind === 'stall' && Object.keys(patch).some((key) => key !== 'enabled')) {
          return c.json(
            { error: 'the stall watcher spawns no agent; only enabled can be set' },
            400,
          )
        }
        // No live mutation here: the serve supervisor re-reads watcher config
        // from disk on every tick and starts or stops watchers to match.
        writeGlobalConfig({ watchers: { [kind]: patch } })
        return c.json(loadGlobalConfig().watchers[kind])
      },
    )

    .post('/api/runs', valid('json', RunBody), async (c) => {
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const { taskId, workerId, model, effort } = c.req.valid('json')
      const opts = {
        ...(workerId === undefined ? {} : { workerId }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      }
      const result = await runner.start(taskId, opts)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json({ taskId: result.taskId }, 201)
    })

    .post('/api/runs/:id/stop', valid('param', TaskIdParam), async (c) => {
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const { id } = c.req.valid('param')
      const result = await runner.stop(id)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json({ taskId: result.taskId })
    })

    .post(
      '/api/repos/:repo/tasks/:id/questions',
      valid('param', RepoTaskIdParam),
      valid('json', AskBody),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const { question, options } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        const questionId = crypto.randomUUID()
        const gateRef = await openQuestionGate(ws.tracker, id, {
          id: questionId,
          text: question,
          options,
        })
        ws.store.append(id, { type: 'question.asked', questionId, question, options, gateRef })
        ws.store.append(id, {
          type: 'task.state',
          from: task.state,
          to: 'awaiting_answer',
        })
        void notifyChannels(notify, ws.store, `question from ${id}`, question)
        return c.json({ task: ws.store.task(id), question: ws.store.question(questionId) }, 201)
      },
    )

    .get(
      '/api/repos/:repo/tasks/:id/questions/:questionId/await',
      valid('param', RepoQuestionParam),
      valid('query', AwaitQuery),
      (c) => {
        const { repo, id, questionId } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { deadlineMs } = c.req.valid('query')
        const question = ws.store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        if (!authorized(c, ws.store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        // An answer that landed before the poll started is not lost.
        if (question.resolvedAt !== null) return c.json({ question })

        return new Promise<Response>((resolve) => {
          let unsub: () => void = () => {}
          let timer: ReturnType<typeof setTimeout> | null = null
          function cleanup(): void {
            if (timer !== null) clearTimeout(timer)
            unsub()
            c.req.raw.signal.removeEventListener('abort', cleanup)
          }
          unsub = ws.store.subscribe((event) => {
            if (event.taskId !== id) return
            const resolved =
              event.type === 'question.timedout' ||
              (event.type === 'question.answered' && event.questionId === questionId)
            if (!resolved) return
            cleanup()
            resolve(c.json({ question: ws.store.question(questionId) }))
          })
          timer = setTimeout(() => {
            ws.store.append(id, { type: 'question.timedout', questionId })
            cleanup()
            resolve(c.json({ question: ws.store.question(questionId) }))
          }, deadlineMs)
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
        })
      },
    )

    .post(
      '/api/repos/:repo/tasks/:id/questions/:questionId/answer',
      valid('param', RepoQuestionParam),
      valid('json', AnswerBody),
      async (c) => {
        const { repo, id, questionId } = c.req.valid('param')
        const { answer, via } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        if (!authorized(c, ws.store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        const question = ws.store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        // Timed out is not answered: a late reply still resumes the parked runner.
        if (question.answer !== null) {
          return c.json({ error: `question ${questionId} already answered` }, 409)
        }
        ws.store.append(id, { type: 'question.answered', questionId, answer, via })
        // Only an awaiting task moves; a question answered after the runner
        // escalated is recorded but must not yank the task out of needs_human.
        if (task.state === 'awaiting_answer') {
          ws.store.append(id, { type: 'task.state', from: task.state, to: 'implementing' })
        }
        await resolveQuestionGate(ws.tracker, question.gateRef)
        return c.json({ task: ws.store.task(id), question: ws.store.question(questionId) })
      },
    )

    .post(
      '/api/repos/:repo/tasks/:id/git-requests',
      valid('param', RepoTaskIdParam),
      valid('json', GitRequestBody),
      async (c) => {
        const { repo, id } = c.req.valid('param')
        const { verb } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        if (!authorized(c, ws.store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        if (task.worktree === null) {
          return c.json({ error: `task ${id} has no worktree to commit` }, 409)
        }
        // The commit is synchronous, so it runs here and the sha returns in
        // the same response; a separate await endpoint would add a round trip.
        const runner = new Runner({
          store: ws.store,
          tracker: ws.tracker,
          harness: makeHarness(ws.config.harness.implement),
          config: ws.config,
          repoRoot: ws.root,
          repoName: ws.name,
          ...(ws.forge === null ? {} : { forge: ws.forge }),
        })
        const result = await runner.requestCommit(id, task.worktree)
        if (!result.ok) return c.json({ error: result.error }, 500)
        return c.json({ verb, sha: result.sha })
      },
    )

    .get('/api/repos/:repo/events', valid('param', RepoParam), valid('query', EventQuery), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { taskId, sinceSeq, limit } = c.req.valid('query')
      return c.json(ws.store.events(taskId ? { taskId, sinceSeq, limit } : { sinceSeq, limit }))
    })

    .get('/api/repos/:repo/stream', valid('param', RepoParam), valid('query', StreamQuery), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { taskId, sinceSeq } = c.req.valid('query')
      // A browser resends the last id it saw on reconnect; that beats whatever
      // sinceSeq was baked into the EventSource url when it first connected.
      const resumed = Number(c.req.header('Last-Event-ID'))
      const from = Number.isInteger(resumed) && resumed >= 0 ? resumed : sinceSeq
      return eventStream(
        c,
        ws.store,
        taskId === undefined ? { sinceSeq: from } : { taskId, sinceSeq: from },
      )
    })

    .get(
      '/api/repos/:repo/questions',
      valid('param', RepoParam),
      valid('query', QuestionQuery),
      (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { taskId } = c.req.valid('query')
        return c.json(ws.store.openQuestions(taskId))
      },
    )

    .post(
      '/api/repos/:repo/run',
      valid('param', RepoParam),
      (c, next) => {
        resolveWorkspace(workspaces, c.req.valid('param').repo)
        return next()
      },
      valid('json', RunBody),
      async (c) => {
        const { repo } = c.req.valid('param')
        if (runner === undefined || runnerRepo !== repo) {
          return c.json({ error: 'runner service is unavailable for this repository' }, 501)
        }
        const { taskId, workerId, model, effort } = c.req.valid('json')
        const result = await runner.start(taskId, {
          ...(workerId === undefined ? {} : { workerId }),
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
        })
        if (!result.ok) return c.json({ error: result.error }, result.status)
        return c.json({ repo, taskId: result.taskId, started: true }, 202)
      },
    )

    .post('/api/repos/:repo/triage', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const triage = new Triage({
        store: ws.store,
        tracker: ws.tracker,
        harness: makeHarness(ws.config.harness.triage),
        config: ws.config,
        repoRoot: ws.root,
        repoName: ws.name,
        ...(ws.forge === null ? {} : { forge: ws.forge }),
      })
      // Triage may hand off to a long implementation run; the request returns
      // immediately and every decision reports through the repo's event stream.
      void triage.triageOnce().catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        ws.store.append(null, { type: 'error', message, fatal: false })
      })
      return c.json({ repo, started: true }, 202)
    })

    .notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404))

    .onError((err, c) => {
      if (err instanceof RepoError) return c.json({ error: err.message }, err.status)
      console.error(err)
      return c.json({ error: err.message }, 500)
    })
}

export type AppType = ReturnType<typeof createApp>
