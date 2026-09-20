import type { Config } from './config.ts'
import { type CreatePrOptions, gitTokenConfig, makePrDriver, type PrDriver } from './drivers/pr.ts'
import type { AgentProcess, Harness, Tracker, TrackerTask } from './drivers/types.ts'
import type { CheckResult, TaskState } from './events.ts'
import { exec as defaultExec, type Exec, execOk } from './exec.ts'
import {
  answerPrompt,
  commitMessage,
  fixChecksPrompt,
  implementPrompt,
  implementSystemPrompt,
} from './prompt.ts'
import type { Store, TaskRow } from './store/store.ts'
import { createWorktree } from './worktree.ts'

export type RunnerDeps = {
  store: Store
  tracker: Tracker
  harness: Harness
  config: Config
  repoRoot: string
  repoName: string
  exec?: Exec
  /** Overridable so tests do not need gh installed. Defaults to the configured forge driver. */
  forge?: PrDriver
}

export type RunOnceResult = {
  task: TaskRow
  state: TaskState
} | null

/** How often the parked runner re-checks the store for an answer. */
const PARK_POLL_MS = 100

class LeaseLostError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId}: claim lease was reclaimed, stopping before another worker collides`)
    this.name = 'LeaseLostError'
  }
}

/**
 * Keeps the tracker claim alive for as long as the task is in flight. bd hands
 * out a short lease and reverts the issue to ready once it lapses, so a long
 * agent run without this silently loses the task to `bd reclaim`.
 */
class Lease {
  private timer: ReturnType<typeof setInterval> | null = null
  private lost = false

  constructor(
    private readonly tracker: Tracker,
    private readonly taskId: string,
    private readonly onLost: () => void,
  ) {}

  start(): void {
    const period = Math.max(30_000, Math.floor(this.tracker.leaseTtlMs / 3))
    this.timer = setInterval(() => {
      void this.tracker.heartbeat(this.taskId).then((alive) => {
        if (alive || this.lost) return
        this.lost = true
        this.onLost()
      })
    }, period)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  get isLost(): boolean {
    return this.lost
  }
}

export class Runner {
  private readonly exec: Exec

  constructor(private readonly deps: RunnerDeps) {
    this.exec = deps.exec ?? defaultExec
  }

  /** Claims one ready task and drives it as far as the current milestone goes. */
  async runOnce(): Promise<RunOnceResult> {
    const task = await this.deps.tracker.claim()
    if (task === null) return null

    const { store } = this.deps
    store.append(task.id, {
      type: 'task.claimed',
      title: task.title,
      tracker: this.deps.tracker.kind,
      description: task.description,
      priority: task.priority,
      taskType: task.type,
      url: task.url,
    })

    try {
      await this.drive(task)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.append(task.id, { type: 'error', message, fatal: true })
      this.transition(task.id, 'needs_human', message)
    }

    const row = store.task(task.id)
    if (row === null) throw new Error(`task ${task.id} vanished from the store mid-run`)
    return { task: row, state: row.state }
  }

  private transition(taskId: string, to: TaskState, reason?: string): void {
    const from = this.deps.store.task(taskId)?.state ?? null
    if (from === to) return
    this.deps.store.append(taskId, {
      type: 'task.state',
      from,
      to,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  private async drive(task: TrackerTask): Promise<void> {
    const { store, config } = this.deps

    // With a token present, base the worktree on a fresh origin fetch over
    // https; without one, fall back to the local base branch so the ssh key
    // never prompts during an unattended run.
    const tokenCfg = config.forge.kind === 'github' ? gitTokenConfig() : []
    if (tokenCfg.length > 0) {
      await execOk(this.exec, ['git', ...tokenCfg, 'fetch', 'origin', config.repo.baseBranch], {
        cwd: this.deps.repoRoot,
      })
    }
    const base = tokenCfg.length > 0 ? `origin/${config.repo.baseBranch}` : config.repo.baseBranch

    const worktree = await createWorktree({
      repoRoot: this.deps.repoRoot,
      repoName: this.deps.repoName,
      taskId: task.id,
      title: task.title,
      baseBranch: base,
      worktreeRoot: config.repo.worktreeRoot,
      setupCmd: config.repo.setupCmd,
      exec: this.exec,
    })
    store.append(task.id, {
      type: 'worktree.created',
      path: worktree.path,
      branch: worktree.branch,
    })
    this.transition(task.id, 'worktree_ready')

    const lease = new Lease(this.deps.tracker, task.id, () => {})
    lease.start()
    try {
      await this.implementAndCheck(task, worktree.path, worktree.branch, lease)
    } finally {
      lease.stop()
    }
  }

  private async implementAndCheck(
    task: TrackerTask,
    cwd: string,
    branch: string,
    lease: Lease,
  ): Promise<void> {
    const { store, config } = this.deps
    const promptCtx = { task, worktree: cwd, branch, askCommand: 'amagi ask "<question>"' }

    this.transition(task.id, 'implementing')
    let sessionId = await this.runAgent(task.id, null, {
      cwd,
      prompt: implementPrompt(promptCtx),
      systemPrompt: implementSystemPrompt(promptCtx),
      ...(config.harness.implement.model === undefined
        ? {}
        : { model: config.harness.implement.model }),
      ...(config.harness.implement.effort === undefined
        ? {}
        : { effort: config.harness.implement.effort }),
      permissions: config.harness.implement.permissions,
      extraArgs: config.harness.implement.extraArgs,
    })

    if (lease.isLost) throw new LeaseLostError(task.id)

    const parked = await this.parkAndResume(task.id, sessionId, cwd, lease)
    if (parked === null) return
    sessionId = parked

    for (let round = 0; round <= config.loop.maxCheckRounds; round++) {
      this.transition(task.id, 'checks')
      const results = await this.runChecks(cwd)
      const ok = results.every((r) => r.exitCode === 0)
      store.append(task.id, { type: 'checks.finished', ok, results })

      if (ok) break
      if (round === config.loop.maxCheckRounds) {
        this.transition(task.id, 'needs_human', 'project checks still failing')
        return
      }
      if (sessionId === null) {
        this.transition(
          task.id,
          'needs_human',
          'checks failed and the agent left no session to resume',
        )
        return
      }

      this.transition(task.id, 'implementing')
      sessionId = await this.runAgent(task.id, sessionId, {
        cwd,
        prompt: fixChecksPrompt(results),
        permissions: config.harness.implement.permissions,
        extraArgs: config.harness.implement.extraArgs,
      })
      if (lease.isLost) throw new LeaseLostError(task.id)

      const resumed = await this.parkAndResume(task.id, sessionId, cwd, lease)
      if (resumed === null) return
      sessionId = resumed
    }

    const committed = await this.commit(task, cwd)
    if (!committed) {
      this.transition(task.id, 'needs_human', 'the agent produced no changes to commit')
      return
    }
    this.transition(task.id, 'committed')
    await this.openPullRequest(task, cwd, branch)
  }

  /**
   * Pushes the worktree branch and opens a pull request. A failed PR (gh not
   * authenticated, remote gone) leaves the commit in place and escalates, so
   * the operator can push and open it by hand.
   */
  private async openPullRequest(task: TrackerTask, cwd: string, branch: string): Promise<void> {
    const { store, config } = this.deps
    const forge = this.deps.forge ?? makePrDriver(config.forge.kind, this.exec)
    const opts: CreatePrOptions = {
      cwd,
      branch,
      base: config.repo.baseBranch,
      remote: config.forge.remote,
      title: task.title,
      body: `Task: ${task.id}\n\n${task.description}`,
    }
    try {
      const pr = await forge.createPr(opts)
      store.append(task.id, { type: 'pr.created', url: pr.url, number: pr.number })
      this.transition(task.id, 'pr_open')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const hint = /auth|login|token|not logged/i.test(message)
        ? ' (gh needs auth: set GH_TOKEN in .env or run gh auth login)'
        : ''
      store.append(task.id, {
        type: 'error',
        message: `pull request: ${message}${hint}`,
        fatal: false,
      })
      this.transition(task.id, 'needs_human', 'pull request creation failed')
    }
  }

  /**
   * When the agent stopped because a question went unanswered, park and poll
   * the store until a human answers, then resume the recorded session with the
   * answer. Never answered within the window: escalate to needs_human.
   * Returns null to stop the whole run. The server and the runner share one
   * SQLite file but not one process, so this polls rather than subscribes.
   */
  private async parkAndResume(
    taskId: string,
    sessionId: string | null,
    cwd: string,
    lease: Lease,
  ): Promise<string | null> {
    const { store, config } = this.deps
    if (store.task(taskId)?.state !== 'awaiting_answer') return sessionId

    const question = store.unansweredQuestions(taskId)[0]
    if (question === undefined) return sessionId
    store.append(taskId, { type: 'question.parked', questionId: question.id })

    const deadline = Date.now() + config.loop.questionParkTimeoutSec * 1000
    while (Date.now() < deadline) {
      if (lease.isLost) throw new LeaseLostError(taskId)
      const q = store.question(question.id)
      if (q !== null && q.answer !== null) {
        this.transition(taskId, 'implementing')
        if (sessionId === null) {
          this.transition(
            taskId,
            'needs_human',
            'the agent left no session to resume with the answer',
          )
          return null
        }
        return this.runAgent(taskId, sessionId, {
          cwd,
          prompt: answerPrompt(question.question, q.answer),
          permissions: config.harness.implement.permissions,
          extraArgs: config.harness.implement.extraArgs,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, PARK_POLL_MS))
    }

    this.transition(taskId, 'needs_human', 'no answer within the parking window')
    return null
  }

  private async runAgent(
    taskId: string,
    resumeFrom: string | null,
    opts: Parameters<Harness['start']>[0],
  ): Promise<string | null> {
    const { store, harness } = this.deps
    const spawn = {
      ...opts,
      env: { AMAGI_TASK_TOKEN: store.token(taskId) },
    }
    const proc: AgentProcess =
      resumeFrom === null ? harness.start(spawn) : harness.resume(resumeFrom, spawn)

    // The resolved model only exists once the harness reports it (claude's
    // init line), so the started event lands on the first stream event.
    let started = false
    for await (const event of proc.events()) {
      if (!started) {
        started = true
        store.append(taskId, {
          type: 'agent.started',
          role: 'implement',
          harness: harness.kind,
          model: proc.model ?? opts.model ?? null,
          effort: proc.effort ?? null,
          cwd: opts.cwd,
          resumed: resumeFrom !== null,
        })
      }
      store.append(taskId, { type: 'agent.stream', role: 'implement', event })
    }

    const outcome = await proc.done
    store.append(taskId, {
      type: 'agent.exited',
      role: 'implement',
      exitCode: outcome.exitCode,
      sessionId: outcome.sessionId,
    })

    if (!outcome.ok) {
      const detail = outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`
      store.append(taskId, { type: 'error', message: `agent failed: ${detail}`, fatal: false })
    }
    return outcome.sessionId
  }

  private async runChecks(cwd: string): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    for (const command of this.deps.config.checks.commands) {
      const r = await this.exec(['sh', '-c', command], { cwd })
      results.push({
        command,
        exitCode: r.exitCode,
        output: `${r.stdout}${r.stderr}`.slice(-8000),
      })
      if (r.exitCode !== 0) break
    }
    return results
  }

  /** Returns false when the agent changed nothing, which is a failure worth surfacing. */
  private async commit(task: TrackerTask, cwd: string): Promise<boolean> {
    const status = await this.exec(['git', 'status', '--porcelain'], { cwd })
    if (status.stdout.trim() === '') return false

    await this.exec(['git', 'add', '-A'], { cwd })
    const message = commitMessage(task)
    const commit = await this.exec(['git', 'commit', '-q', '-F', '-'], { cwd, stdin: message })
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`)
    }

    const sha = (await this.exec(['git', 'rev-parse', 'HEAD'], { cwd })).stdout.trim()
    this.deps.store.append(task.id, {
      type: 'commit.created',
      sha,
      subject: task.title,
    })
    return true
  }
}
