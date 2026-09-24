import type { Config } from './config.ts'
import type { Harness } from './drivers/types.ts'
import { agentFailure, errMsg } from './errors.ts'
import type { Store } from './store/store.ts'

export type ChatResult = { ok: true } | { ok: false; status: 404 | 409; error: string }

export type ChatDeps = {
  store: Store
  harness: Harness
  config: Config
}

/**
 * Lets the operator chat with the worker behind a parked no_pr task. The
 * worker process is long gone, so each message dispatches a fresh harness run
 * that resumes the task's recorded session in its preserved worktree; the
 * answer streams back through the repo event stream like any agent run. The
 * session id lives on the task row, so a resume reports whichever session the
 * harness ends up on (it may stay the same or mint a new id).
 */
export class ChatService {
  /** Tasks with a chat run in flight, so overlapping messages do not fork the session. */
  private readonly busy = new Set<string>()

  constructor(private readonly deps: ChatDeps) {}

  send(taskId: string, message: string): ChatResult {
    const task = this.deps.store.task(taskId)
    if (task === null) return { ok: false, status: 404, error: `unknown task ${taskId}` }
    if (task.state !== 'no_pr') {
      return { ok: false, status: 409, error: `task ${taskId} is not in no_pr state` }
    }
    if (task.statusReason === null) {
      return { ok: false, status: 409, error: `task ${taskId} has no summary to chat about` }
    }
    if (task.worktree === null || task.sessionId === null) {
      return {
        ok: false,
        status: 409,
        error: `task ${taskId} has no session to resume in its worktree`,
      }
    }
    if (this.busy.has(taskId)) {
      return { ok: false, status: 409, error: `worker for ${taskId} is already responding` }
    }
    this.busy.add(taskId)
    this.deps.store.append(taskId, { type: 'chat.message', text: message })
    void this.respond(taskId, task.worktree, task.sessionId, message)
    return { ok: true }
  }

  private async respond(
    taskId: string,
    cwd: string,
    sessionId: string,
    message: string,
  ): Promise<void> {
    const { store, harness, config } = this.deps
    try {
      const proc = harness.resume(sessionId, {
        cwd,
        prompt: message,
        ...(config.harness.implement.seat === undefined
          ? {}
          : { seat: config.harness.implement.seat }),
        permissions: config.harness.implement.permissions,
        extraArgs: config.harness.implement.extraArgs,
      })
      let started = false
      for await (const event of proc.events()) {
        if (!started && event.kind !== 'status') {
          started = true
          store.append(taskId, {
            type: 'agent.started',
            role: 'chat',
            harness: harness.kind,
            seat: config.harness.implement.seat ?? harness.kind,
            model: proc.model ?? null,
            effort: proc.effort ?? null,
            cwd,
            resumed: true,
          })
        }
        store.append(taskId, {
          type: 'agent.stream',
          role: 'chat',
          event:
            event.kind === 'usage'
              ? { ...event, seat: config.harness.implement.seat ?? harness.kind }
              : event,
        })
      }
      const outcome = await proc.done
      store.append(taskId, {
        type: 'agent.exited',
        role: 'chat',
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId,
      })
      if (!outcome.ok) {
        const detail = agentFailure(outcome)
        store.append(taskId, {
          type: 'error',
          message: `chat agent failed: ${detail}`,
          fatal: false,
        })
      }
    } catch (err) {
      const message = errMsg(err)
      store.append(taskId, { type: 'error', message: `chat failed: ${message}`, fatal: false })
    } finally {
      this.busy.delete(taskId)
    }
  }
}
