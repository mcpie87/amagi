import {
  type BeadsIssue,
  CAPABILITY_WORDS,
  ChatService,
  type Config,
  classifyDifficulty,
  isTerminal,
  makeHarness,
  type Notifier,
  type Question,
  type RunServiceApi,
  removeWorktree,
  type Store,
  type Tracker,
  type TrackerCapabilities,
  type TrackerTask,
  UnsupportedCapabilityError,
  type UpdateTrackerTask,
  type WorkerActivity,
  writeConfig,
} from '@amagi/core'
import type { Harness } from '@amagi/core/drivers/types'
import { zValidator } from '@hono/zod-validator'
import type { Context, ValidationTargets } from 'hono'
import { Hono } from 'hono'
import * as z from 'zod'
import {
  AnswerBody,
  AskBody,
  AwaitQuery,
  ChatBody,
  CloseTaskBody,
  EventQuery,
  IssueCreateBody,
  IssueIdParam,
  IssueUpdateBody,
  QuestionQuery,
  RunBody,
  SettingsBody,
  StreamQuery,
  TaskIdParam,
  TaskListQuery,
  TaskQuestionParam,
} from './schemas.ts'
import { eventStream } from './stream.ts'

export type ServerDeps = {
  store: Store
  notify?: Notifier[]
  /**
   * When present, questions open a blocking gate on the tracker issue so a
   * human answering outside amagi (e.g. `bd gate resolve`) can still unblock
   * the agent. Absent in tests that exercise the question channel alone.
   */
  tracker?: Tracker
  listIssues?: () => Promise<BeadsIssue[]>
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi
  /** Rich issue detail, including dependency blockers, when the tracker has it. */
  getIssue?: (id: string) => Promise<BeadsIssue | null>
  /** Repo root, so an instant close can also remove the task's worktree. */
  repoRoot?: string
  /** Config for difficulty classification and the default chat harness. */
  config?: Config
  /** Background worker activity (mention/stall watchers), merged into /api/runner. */
  workers?: () => WorkerActivity[]
  /** Overridable so tests stub the harness a task's chat uses. */
  chatHarnessFor?: () => Harness
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
      console.warn(`notify ${notifier.kind}: ${err instanceof Error ? err.message : String(err)}`)
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
    console.warn(`openGate ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
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
    console.warn(`resolveGate ${gateRef}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function createApp({
  store,
  notify = [],
  tracker,
  listIssues,
  runner,
  getIssue,
  repoRoot,
  config,
  workers,
  chatHarnessFor,
}: ServerDeps) {
  // One ChatService for the repo, so the in-flight guard survives requests.
  let chat: ChatService | null = null
  const chatService = (): ChatService | null => {
    if (chat !== null) return chat
    if (config === undefined) return null
    const harness = chatHarnessFor?.() ?? makeHarness(config.harness.implement)
    chat = new ChatService({ store, harness, config })
    return chat
  }
  return new Hono()
    .get('/api/health', (c) => c.json({ ok: true }))

    .get('/api/issues', async (c) => {
      if (listIssues === undefined) return c.json({ error: 'issue browser is unavailable' }, 501)
      return c.json(await listIssues())
    })

    .get('/api/issues/:id', valid('param', IssueIdParam), async (c) => {
      const { id } = c.req.valid('param')
      if (getIssue === undefined) return c.json({ error: 'issue detail is unavailable' }, 501)
      const issue = await getIssue(id)
      if (issue === null) return c.json({ error: `unknown issue ${id}` }, 404)
      return c.json(issue)
    })

    .post('/api/issues', valid('json', IssueCreateBody), async (c) => {
      if (tracker === undefined) return c.json({ error: 'no tracker is configured' }, 501)
      const cap = capabilityError(tracker, 'create')
      if (cap !== null) return c.json({ error: cap }, 501)
      try {
        const body = c.req.valid('json')
        const input =
          config?.difficulty.enabled === true
            ? {
                ...body,
                difficulty: await classifyDifficulty(body.title, body.description, config),
              }
            : body
        const created: TrackerTask = await tracker.createTask(input)
        const issue = getIssue === undefined ? null : await getIssue(created.id)
        return c.json(issue ?? created, 201)
      } catch (err) {
        if (err instanceof UnsupportedCapabilityError) return c.json({ error: err.message }, 501)
        throw err
      }
    })

    .patch(
      '/api/issues/:id',
      valid('param', IssueIdParam),
      valid('json', IssueUpdateBody),
      async (c) => {
        const { id } = c.req.valid('param')
        if (tracker === undefined) return c.json({ error: 'no tracker is configured' }, 501)
        const body = c.req.valid('json')
        const input: UpdateTrackerTask = {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.acceptanceCriteria === undefined
            ? {}
            : { acceptanceCriteria: body.acceptanceCriteria }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.labels === undefined ? {} : { labels: body.labels }),
        }
        // Only the operation actually requested is gated, so a dependency-only
        // edit reports the dependency gap rather than a generic edit gap.
        if (Object.keys(input).length > 0) {
          const editCap = capabilityError(tracker, 'edit')
          if (editCap !== null) return c.json({ error: editCap }, 501)
        }
        // The board edits dependencies as a full set; the tracker wants a diff.
        if (body.dependencies !== undefined) {
          const depCap = capabilityError(tracker, 'dependencies')
          if (depCap !== null) return c.json({ error: depCap }, 501)
          if (getIssue === undefined) {
            return c.json({ error: 'cannot resolve dependency changes without issue detail' }, 501)
          }
          const current = (await getIssue(id))?.dependencies.map((d) => d.id) ?? []
          input.dependencies = {
            add: body.dependencies.filter((d) => !current.includes(d)),
            remove: current.filter((d) => !body.dependencies?.includes(d)),
          }
        }
        try {
          const updated = await tracker.updateTask(id, input)
          const issue = getIssue === undefined ? null : await getIssue(updated.id)
          return c.json(issue ?? updated)
        } catch (err) {
          if (err instanceof UnsupportedCapabilityError) {
            return c.json({ error: err.message }, 501)
          }
          throw err
        }
      },
    )

    .get('/api/tasks', valid('query', TaskListQuery), (c) => {
      const { state, limit } = c.req.valid('query')
      return c.json(store.tasks(state ? { states: state, limit } : { limit }))
    })

    .get('/api/tasks/:id', valid('param', TaskIdParam), (c) => {
      const task = store.task(c.req.valid('param').id)
      if (!task) return c.json({ error: `unknown task ${c.req.valid('param').id}` }, 404)
      // The dashboard answers via the token-bound endpoint but has no other
      // channel for the credential, so the task detail doubles as its source.
      return c.json({ task, token: store.token(task.id), questions: store.openQuestions(task.id) })
    })

    .post('/api/tasks/:id/reclaim', valid('param', TaskIdParam), async (c) => {
      const { id } = c.req.valid('param')
      const task = store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      if (task.worktree === null || task.branch === null) {
        return c.json({ error: `task ${id} has no worktree to resume` }, 409)
      }
      // A terminal run keeps its worktree for exactly this path: a cancelled
      // run was deliberately stopped, and a needs_human/no_pr run was parked
      // for attention, the operator retries each to resume where it left off.
      if (isTerminal(task.state) && !['cancelled', 'needs_human', 'no_pr'].includes(task.state)) {
        return c.json({ error: `task ${id} is in terminal state ${task.state}` }, 409)
      }
      // Best effort: the runner only re-claims issues the tracker sees as
      // ready, so a lapsed or still-live claim is released for it to pick up.
      if (tracker !== undefined) {
        try {
          await tracker.release(id)
        } catch (err) {
          console.warn(`release ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      store.append(id, { type: 'task.reclaimed' })
      return c.json({ task: store.task(id) })
    })

    .post(
      '/api/tasks/:id/close',
      valid('param', TaskIdParam),
      valid('json', CloseTaskBody),
      async (c) => {
        const { id } = c.req.valid('param')
        const { reason, to } = c.req.valid('json')
        const task = store.task(id)
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
        // Shut the worker down first: stop() kills the owned agent process and
        // parks a live run in cancelled, releasing the tracker claim, so the
        // close below retires it without racing the run. A task not running on
        // this server's runner (CLI run, another server) is simply not stopped.
        if (runner !== undefined) {
          try {
            await runner.stop(id)
          } catch (err) {
            console.warn(`stop on close ${id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        const afterStop = store.task(id)
        store.append(id, {
          type: 'task.state',
          from: afterStop?.state ?? task.state,
          to,
          reason,
        })
        // Best effort like reconcile: the store is authoritative, so a git or
        // tracker hiccup logs the failure instead of losing the operator's close.
        if (afterStop !== null && afterStop.worktree !== null && repoRoot !== undefined) {
          const { worktree, branch } = afterStop
          try {
            await removeWorktree(store, id, {
              repoRoot,
              path: worktree,
              branch: branch ?? null,
            })
          } catch (err) {
            console.warn(
              `worktree removal on close ${id}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (tracker !== undefined) {
          try {
            await tracker.close(id, reason)
          } catch (err) {
            console.warn(`close ${id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return c.json({ task: store.task(id) })
      },
    )

    .post('/api/tasks/:id/chat', valid('param', TaskIdParam), valid('json', ChatBody), (c) => {
      const { id } = c.req.valid('param')
      const { message } = c.req.valid('json')
      const service = chatService()
      if (service === null) {
        return c.json({ error: 'chat is unavailable without a config' }, 501)
      }
      const result = service.send(id, message)
      if (!result.ok) return c.json({ error: result.error }, result.status)
      // The answer streams back through the event stream like any agent run,
      // so the request returns before the run finishes.
      return c.json({ taskId: id }, 202)
    })

    .get('/api/runner', async (c) => {
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const status = await runner.status()
      if (workers === undefined) return c.json(status)
      return c.json({ ...status, workers: workers() })
    })

    .get('/api/settings', (c) => {
      if (config === undefined) return c.json({ error: 'settings are unavailable' }, 501)
      return c.json({ maxParallel: config.loop.maxParallel })
    })

    .patch('/api/settings', valid('json', SettingsBody), (c) => {
      if (config === undefined) return c.json({ error: 'settings are unavailable' }, 501)
      const { maxParallel } = c.req.valid('json')
      // Persist first so a restart keeps the value, then live-apply: the
      // cached config and, when present, the runner capacity. In-flight runs
      // are untouched, capacity gates new launches.
      if (repoRoot !== undefined) writeConfig(repoRoot, { loop: { maxParallel } })
      config.loop.maxParallel = maxParallel
      runner?.setMaxParallel(maxParallel)
      return c.json({ maxParallel })
    })

    .post('/api/runs', valid('json', RunBody), async (c) => {
      if (runner === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const { taskId } = c.req.valid('json')
      const result = await runner.start(taskId)
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
      '/api/tasks/:id/questions',
      valid('param', TaskIdParam),
      valid('json', AskBody),
      async (c) => {
        const { id } = c.req.valid('param')
        const { question, options } = c.req.valid('json')
        const task = store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        const questionId = crypto.randomUUID()
        const gateRef = await openQuestionGate(tracker, id, {
          id: questionId,
          text: question,
          options,
        })
        store.append(id, { type: 'question.asked', questionId, question, options, gateRef })
        store.append(id, {
          type: 'task.state',
          from: task.state,
          to: 'awaiting_answer',
        })
        void notifyChannels(notify, store, `question from ${id}`, question)
        return c.json({ task: store.task(id), question: store.question(questionId) }, 201)
      },
    )

    .get(
      '/api/tasks/:id/questions/:questionId/await',
      valid('param', TaskQuestionParam),
      valid('query', AwaitQuery),
      (c) => {
        const { id, questionId } = c.req.valid('param')
        const { deadlineMs } = c.req.valid('query')
        const question = store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        if (!authorized(c, store, id)) {
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
          unsub = store.subscribe((event) => {
            if (event.taskId !== id) return
            const resolved =
              event.type === 'question.timedout' ||
              (event.type === 'question.answered' && event.questionId === questionId)
            if (!resolved) return
            cleanup()
            resolve(c.json({ question: store.question(questionId) }))
          })
          timer = setTimeout(() => {
            store.append(id, { type: 'question.timedout', questionId })
            cleanup()
            resolve(c.json({ question: store.question(questionId) }))
          }, deadlineMs)
          c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
        })
      },
    )

    .post(
      '/api/tasks/:id/questions/:questionId/answer',
      valid('param', TaskQuestionParam),
      valid('json', AnswerBody),
      async (c) => {
        const { id, questionId } = c.req.valid('param')
        const { answer, via } = c.req.valid('json')
        const task = store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        if (!authorized(c, store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        const question = store.question(questionId)
        if (!question) return c.json({ error: `unknown question ${questionId}` }, 404)
        if (question.taskId !== id) {
          return c.json({ error: `question ${questionId} does not belong to task ${id}` }, 404)
        }
        // Timed out is not answered: a late reply still resumes the parked runner.
        if (question.answer !== null) {
          return c.json({ error: `question ${questionId} already answered` }, 409)
        }
        store.append(id, { type: 'question.answered', questionId, answer, via })
        // Only an awaiting task moves; a question answered after the runner
        // escalated is recorded but must not yank the task out of needs_human.
        if (task.state === 'awaiting_answer') {
          store.append(id, { type: 'task.state', from: task.state, to: 'implementing' })
        }
        await resolveQuestionGate(tracker, question.gateRef)
        return c.json({ task: store.task(id), question: store.question(questionId) })
      },
    )

    .get('/api/events', valid('query', EventQuery), (c) => {
      const { taskId, sinceSeq, limit } = c.req.valid('query')
      return c.json(store.events(taskId ? { taskId, sinceSeq, limit } : { sinceSeq, limit }))
    })

    .get('/api/stream', valid('query', StreamQuery), (c) => {
      const { taskId, sinceSeq } = c.req.valid('query')
      // A browser resends the last id it saw on reconnect; that beats whatever
      // sinceSeq was baked into the EventSource url when it first connected.
      const resumed = Number(c.req.header('Last-Event-ID'))
      const from = Number.isInteger(resumed) && resumed >= 0 ? resumed : sinceSeq
      return eventStream(
        c,
        store,
        taskId === undefined ? { sinceSeq: from } : { taskId, sinceSeq: from },
      )
    })

    .get('/api/questions', valid('query', QuestionQuery), (c) => {
      const { taskId } = c.req.valid('query')
      return c.json(store.openQuestions(taskId))
    })

    .notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404))

    .onError((err, c) => {
      console.error(err)
      return c.json({ error: err.message }, 500)
    })
}

export type AppType = ReturnType<typeof createApp>
