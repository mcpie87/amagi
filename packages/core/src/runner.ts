import type { Config } from './config.ts'
import type { AgentProcess, Harness, Tracker, TrackerTask } from './drivers/types.ts'
import type { CheckResult, TaskState } from './events.ts'
import { exec as defaultExec, type Exec } from './exec.ts'
import { commitMessage, fixChecksPrompt, implementPrompt, implementSystemPrompt } from './prompt.ts'
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
}

export type RunOnceResult = {
  task: TaskRow
  state: TaskState
} | null

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

    const worktree = await createWorktree({
      repoRoot: this.deps.repoRoot,
      repoName: this.deps.repoName,
      taskId: task.id,
      title: task.title,
      baseBranch: config.repo.baseBranch,
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
    const promptCtx = { task, worktree: cwd, branch, askCommand: null }

    this.transition(task.id, 'implementing')
    let sessionId = await this.runAgent(task.id, null, {
      cwd,
      prompt: implementPrompt(promptCtx),
      systemPrompt: implementSystemPrompt(promptCtx),
      ...(config.harness.implement.model === undefined
        ? {}
        : { model: config.harness.implement.model }),
      permissions: config.harness.implement.permissions,
      extraArgs: config.harness.implement.extraArgs,
    })

    if (lease.isLost) throw new LeaseLostError(task.id)

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
    }

    const committed = await this.commit(task, cwd)
    if (!committed) {
      this.transition(task.id, 'needs_human', 'the agent produced no changes to commit')
      return
    }
    this.transition(task.id, 'committed')
  }

  private async runAgent(
    taskId: string,
    resumeFrom: string | null,
    opts: Parameters<Harness['start']>[0],
  ): Promise<string | null> {
    const { store, harness } = this.deps
    const proc: AgentProcess =
      resumeFrom === null ? harness.start(opts) : harness.resume(resumeFrom, opts)

    store.append(taskId, {
      type: 'agent.started',
      role: 'implement',
      harness: harness.kind,
      cwd: opts.cwd,
      resumed: resumeFrom !== null,
    })

    for await (const event of proc.events()) {
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
