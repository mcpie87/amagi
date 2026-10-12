import {
  CHECKPOINT_COMMIT_SUMMARY,
  type ChatService,
  canReset,
  errMsg,
  exec,
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  HUMAN_ONLY_LABEL,
  isTerminal,
  type LiveRun,
  mergeBaseForChat,
  mergeLiveRuns,
  type Notifier,
  type Question,
  type RunServiceApi,
  reconcilePr,
  removeWorktree,
  runApprovedGitRequest,
  type Store,
  type StoredEvent,
  stageAndCommit,
  type Tracker,
  type WorkerActivity,
  type Workspace,
  type Workspaces,
} from '@amagi/core'
import { Hono } from 'hono'
import { capabilityError, resolveWorkspace, valid } from './route-utils.ts'
import {
  AgentLogQuery,
  AnswerBody,
  AskBody,
  AwaitQuery,
  ChatBody,
  CloseTaskBody,
  GitDecisionBody,
  GitRequestBody,
  RepoGitRequestParam,
  RepoParam,
  RepoQuestionParam,
  RepoTaskIdParam,
  RunBody,
  TaskListQuery,
  WatcherHistoryParam,
  WatcherHistoryQuery,
} from './schemas.ts'

export type TaskRouteDeps = {
  workspaces: Workspaces
  notify: Notifier[]
  runnerFor: (repo: string) => RunServiceApi | undefined
  workers: (() => WorkerActivity[]) | undefined
  liveRuns: (() => LiveRun[]) | undefined
  queueConflictResolution:
    | ((repo: string, prNumber: number, prUrl: string | null) => boolean)
    | undefined
  chatFor: (ws: Workspace) => ChatService
  authorized: (c: import('hono').Context, store: Store, id: string) => boolean
  openQuestionGate: (
    tracker: Tracker | undefined,
    taskId: string,
    question: Question,
  ) => Promise<string | null>
  resolveQuestionGate: (tracker: Tracker | undefined, gateRef: string | null) => Promise<void>
  notifyChannels: (
    notifiers: Notifier[],
    store: Store,
    title: string,
    body: string,
    desktopFailureAlerts?: boolean,
  ) => Promise<void>
}

export function createTaskRoutes({
  workspaces,
  notify,
  runnerFor,
  workers,
  liveRuns,
  queueConflictResolution,
  chatFor,
  authorized,
  openQuestionGate,
  resolveQuestionGate,
  notifyChannels,
}: TaskRouteDeps) {
  /** Git requests being carried out, so a double click cannot push or comment twice. */
  const deciding = new Set<string>()

  return new Hono()
    .post('/api/repos/:repo/tasks/:id/stop', valid('param', RepoTaskIdParam), (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { store } = ws
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
      void runnerFor(repo)?.stop(id)
      return c.json({ task: store.task(id) })
    })

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
      return c.json({ task, questions: ws.store.openQuestions(id) })
    })

    .get(
      '/api/repos/:repo/tasks/:id/agent-log',
      valid('param', RepoTaskIdParam),
      valid('query', AgentLogQuery),
      (c) => {
        const { repo, id } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { attempt, untilSeq, limit } = c.req.valid('query')
        return c.json(ws.store.agentLog(id, attempt, untilSeq, limit))
      },
    )

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
      const runner = runnerFor(repo)
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
      // The runner only claims ready issues, so a reset of a closed one would
      // sit in claimed until the stall watcher parks it as closed remotely.
      try {
        const issue = await ws.tracker.get(id)
        if (issue?.status === 'closed') await ws.tracker.setStatus(id, 'open')
      } catch (err) {
        return c.json({ error: `failed to reopen tracker issue: ${errMsg(err)}` }, 500)
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
      const runner = runnerFor(repo)
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
      if (ws.prForge === null) {
        return c.json({ error: `forge driver unavailable for ${repo}` }, 501)
      }
      const { driver, config } = ws.prForge(task.prUrl)
      // The reconcile writes events the dashboard already streams, so the
      // caller's live state picks up a merge/close without a page reload.
      await reconcilePr(ws.store, driver, ws.tracker, ws.root, config.forge.remote, task)
      return c.json({ task: ws.store.task(id) })
    })

    .post('/api/repos/:repo/tasks/:id/resolve-conflicts', valid('param', RepoTaskIdParam), (c) => {
      const { repo, id } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const task = ws.store.task(id)
      if (!task) return c.json({ error: `unknown task ${id}` }, 404)
      if (task.state !== 'pr_merge_conflict' || task.prMergeStatus !== 'conflicted') {
        return c.json({ error: `task ${id} has no open conflicted PR` }, 409)
      }
      if (task.prNumber === null) {
        return c.json({ error: `task ${id} has no recorded pull request number` }, 409)
      }
      if (queueConflictResolution?.(repo, task.prNumber, task.prUrl) !== true) {
        return c.json({ error: `PR conflict watcher is unavailable for ${repo}` }, 501)
      }
      ws.store.append(task.id, {
        type: 'task.state',
        from: task.state,
        to: 'pr_conflict_fixing',
        reason: `Conflict resolution queued for PR #${task.prNumber}`,
      })
      return c.json({ taskId: id, queued: true })
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
          if (ws.prForge === null) {
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
            await ws.prForge(task.prUrl).driver.closePr(ws.root, task.prNumber, reason)
          } catch (err) {
            return c.json({ error: `failed to close pull request: ${errMsg(err)}` }, 502)
          }
        }
        // Shut the worker down first: stop() kills the owned agent process and
        // parks a live run in cancelled, releasing the tracker claim, so the
        // close below retires it without racing the run. A task not running on
        // this server's runner (CLI run, another server) is simply not stopped.
        const runner = runnerFor(repo)
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

    .get('/api/repos/:repo/runner', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const service = runnerFor(repo)
      if (service === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      let status = await service.status()
      if (liveRuns !== undefined) {
        status = await mergeLiveRuns(status, liveRuns(), undefined, repo)
      }
      if (workers === undefined) return c.json(status)
      return c.json({ ...status, workers: workers().filter((worker) => worker.repo === repo) })
    })

    .get(
      '/api/repos/:repo/watchers/:name/runs',
      valid('param', WatcherHistoryParam),
      valid('query', WatcherHistoryQuery),
      (c) => {
        const { repo, name } = c.req.valid('param')
        const { limit, beforeSeq } = c.req.valid('query')
        const ws = resolveWorkspace(workspaces, repo)
        const runs = ws.store.watcherRuns({
          repo,
          name,
          limit,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        })
        return c.json({ runs, nextBeforeSeq: runs.at(-1)?.startSeq ?? null })
      },
    )

    .get('/api/repos/:repo/runner/options', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      if (runnerFor(repo) === undefined) {
        return c.json({ harnesses: [], models: {}, efforts: {}, default: null })
      }
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

    .post('/api/repos/:repo/runs', valid('param', RepoParam), valid('json', RunBody), async (c) => {
      const { repo } = c.req.valid('param')
      const service = runnerFor(repo)
      if (service === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const { taskId, workerId, model, effort } = c.req.valid('json')
      const result = await service.start(taskId, {
        ...(workerId === undefined ? {} : { workerId }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
      })
      if (!result.ok) return c.json({ error: result.error }, result.status)
      return c.json({ taskId: result.taskId }, 201)
    })

    .post('/api/repos/:repo/runs/:id/stop', valid('param', RepoTaskIdParam), async (c) => {
      const { repo, id } = c.req.valid('param')
      const service = runnerFor(repo)
      if (service === undefined) return c.json({ error: 'runner service is unavailable' }, 501)
      const result = await service.stop(id)
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
        if (!authorized(c, ws.store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
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
        void notifyChannels(
          notify,
          ws.store,
          `question from ${id}`,
          question,
          ws.config.notify.desktopFailureAlerts,
        )
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
        const { verb, message } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        if (!authorized(c, ws.store, id)) {
          return c.json({ error: 'task token mismatch' }, 401)
        }
        if (task.worktree === null) {
          return c.json({ error: `task ${id} has no worktree to commit` }, 409)
        }
        if (verb === 'merge-base') {
          try {
            const result = await mergeBaseForChat(
              { config: ws.config, exec, repoRoot: ws.root },
              task.worktree,
            )
            return c.json({ verb, result })
          } catch (err) {
            return c.json({ error: errMsg(err) }, 500)
          }
        }
        if (verb !== 'commit') {
          // Outward-facing: the operator approves it in the chat, and the
          // result reaches the agent as its next chat message.
          const requestId = crypto.randomUUID()
          ws.store.append(id, {
            type: 'git.request',
            requestId,
            verb,
            ...(message === undefined ? {} : { message }),
          })
          return c.json(
            {
              verb,
              requestId,
              result: `requested ${verb}; it waits for the operator's approval in the chat. End your turn now: the decision and its result arrive as the next message.`,
            },
            202,
          )
        }
        // The commit is synchronous, so it runs here and the sha returns in
        // the same response; a separate await endpoint would add a round trip.
        try {
          const staged = await stageAndCommit(
            exec,
            task,
            task.worktree,
            message ?? CHECKPOINT_COMMIT_SUMMARY,
            {
              harness: ws.config.harness.implement.kind,
              model: ws.config.harness.implement.model ?? null,
              effort: ws.config.harness.implement.effort ?? null,
            },
          )
          if (!staged.committed) {
            return c.json({ error: 'nothing to commit; the worktree is clean' }, 500)
          }
          ws.store.append(id, {
            type: 'commit.created',
            sha: staged.sha,
            subject: `[${task.id}] ${task.title}`,
          })
          return c.json({ verb, sha: staged.sha })
        } catch (err) {
          return c.json({ error: errMsg(err) }, 500)
        }
      },
    )

    .post(
      '/api/repos/:repo/tasks/:id/git-requests/:requestId/decision',
      valid('param', RepoGitRequestParam),
      valid('json', GitDecisionBody),
      async (c) => {
        const { repo, id, requestId } = c.req.valid('param')
        const { approve } = c.req.valid('json')
        const ws = resolveWorkspace(workspaces, repo)
        const task = ws.store.task(id)
        if (!task) return c.json({ error: `unknown task ${id}` }, 404)
        let request: Extract<StoredEvent, { type: 'git.request' }> | null = null
        for (const event of ws.store.events({
          taskId: id,
          limit: 100_000,
          withoutAgentLog: true,
        })) {
          if (event.type === 'git.request' && event.requestId === requestId) request = event
          if (event.type === 'git.request.decided' && event.requestId === requestId) {
            return c.json({ error: `git request ${requestId} was already decided` }, 409)
          }
        }
        if (request === null) return c.json({ error: `unknown git request ${requestId}` }, 404)
        if (deciding.has(requestId)) {
          return c.json({ error: `git request ${requestId} is already being carried out` }, 409)
        }
        let result: string
        let ok = true
        if (!approve) {
          result = `the operator declined ${request.verb}`
        } else {
          deciding.add(requestId)
          try {
            result = await runApprovedGitRequest(
              {
                store: ws.store,
                tracker: ws.tracker,
                config: ws.config,
                repoRoot: ws.root,
                repoName: ws.name,
                exec,
                forge: ws.forge,
              },
              task,
              request.verb,
              request.message,
            )
          } catch (err) {
            ok = false
            result = `${request.verb} failed: ${errMsg(err)}`
          } finally {
            deciding.delete(requestId)
          }
        }
        ws.store.append(id, { type: 'git.request.decided', requestId, approved: approve, result })
        return c.json({ requestId, approved: approve, ok, result })
      },
    )
}
