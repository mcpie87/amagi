import { tmpdir } from 'node:os'
import * as z from 'zod'
import type { Config } from './config.ts'
import type { PrDriver } from './drivers/pr.ts'
import type { BeadsIssue } from './drivers/tracker/beads.ts'
import type { Harness, Question, Tracker, TrackerTask } from './drivers/types.ts'
import {
  isTerminal,
  type StoredEvent,
  TriageAction,
  type TriageAction as TriageActionType,
} from './events.ts'
import type { Exec } from './exec.ts'
import { harnessStartOpts, makeHarness } from './factory.ts'
import {
  type TriagePromptContext,
  type TriageTaskView,
  triagePrompt,
  triageSystemPrompt,
} from './prompt.ts'
import { Runner, type RunnerDeps, type RunOnceResult } from './runner.ts'
import type { Store } from './store/store.ts'

/** The slice of the Tracker a triage worker needs; the beads tracker has all of it. */
export type TriageTracker = Tracker & {
  list(limit?: number): Promise<BeadsIssue[]>
  children(id: string): Promise<BeadsIssue[]>
  getIssue(id: string): Promise<BeadsIssue | null>
}

/** Structured decision the triage harness reports back. */
export const TriageDecision = z.object({
  action: TriageAction,
  reason: z.string().trim().min(1),
  subtasks: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        description: z.string().default(''),
        acceptanceCriteria: z.string().nullable().default(null),
        priority: z.number().int().min(0).max(4).nullable().default(null),
      }),
    )
    .default([]),
  question: z.string().optional(),
  options: z.array(z.string()).default([]),
})
export type TriageDecision = z.infer<typeof TriageDecision>

/** Best-effort JSON extraction from the harness reply; anything else is a null. */
export function parseTriageDecision(reply: string): TriageDecision | null {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return TriageDecision.parse(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return null
  }
}

/** Maps a free-form operator answer onto an action; unknown answers fall back. */
export function actionFromAnswer(answer: string, fallback: TriageActionType): TriageActionType {
  const lower = answer.toLowerCase()
  for (const action of TriageAction.options) {
    if (lower.includes(action)) return action
  }
  return fallback
}

export type TriageDeps = {
  store: Store
  tracker: Tracker
  /** The harness that makes the triage decision; never touches the repository. */
  harness: Harness
  config: Config
  repoRoot: string
  repoName: string
  exec?: Exec
  forge?: PrDriver
  /** Test seam: how an `implement` decision is handed off. Defaults to the Runner. */
  makeRunner?: (deps: RunnerDeps) => TriageImplementer
}

/** The slice of the implementation runner a triage worker hands tasks to. */
export type TriageImplementer = {
  runClaimed(task: TrackerTask): Promise<RunOnceResult>
}

export type TriageResult = {
  task: TrackerTask
  action: TriageActionType
  reason: string
  /** Human-readable summary of the action taken. */
  result: string
} | null

/**
 * The triage worker: a decision role separate from the implementation runner.
 * It picks an unclaimed task (any type, including epics the runner skips),
 * asks a harness to decide what to do with it, and executes that decision.
 * It never writes code itself: an `implement` decision claims the task and
 * hands it to the Runner.
 */
export class Triage {
  private readonly store: Store
  private readonly tracker: TriageTracker
  private readonly harness: Harness
  private readonly config: Config
  private readonly repoRoot: string
  private readonly repoName: string
  private readonly exec: Exec | undefined
  private readonly forge: PrDriver | undefined
  private readonly makeRunner: (deps: RunnerDeps) => TriageImplementer

  constructor(deps: TriageDeps) {
    this.store = deps.store
    this.tracker = deps.tracker as TriageTracker
    this.harness = deps.harness
    this.config = deps.config
    this.repoRoot = deps.repoRoot
    this.repoName = deps.repoName
    this.exec = deps.exec
    this.forge = deps.forge
    this.makeRunner = deps.makeRunner ?? defaultMakeRunner
  }

  /** Picks one unclaimed task, decides what to do with it, and acts. */
  async triageOnce(): Promise<TriageResult> {
    assertTriageTracker(this.tracker)
    const issue = await this.pickCandidate()
    if (issue === null) return null

    const last = this.lastDecision(issue.id)
    const answeredAsk = this.answeredAsk(last)
    let decision: TriageDecision
    if (answeredAsk !== null) {
      decision = {
        action: actionFromAnswer(answeredAsk.answer, 'skip'),
        reason: `operator answered: ${answeredAsk.answer}`,
        subtasks: [],
        options: [],
      }
    } else {
      const context = await this.contextFor(issue)
      const decided = await this.decide(issue, context)
      decision = decided ?? {
        action: 'skip',
        reason: 'triage could not parse a decision from the harness',
        subtasks: [],
        options: [],
      }
    }

    // The ask question is built up front so the decision event carries its id
    // and the answer can be matched back on a later pass.
    let askQuestion: Question | null = null
    if (decision.action === 'ask') {
      askQuestion = buildAskQuestion(issue, decision)
      decision = { ...decision, question: askQuestion.text, options: [...askQuestion.options] }
    }
    this.recordDecision(issue, decision, askQuestion?.id)
    const result = await this.act(issue, decision, askQuestion)
    return { task: issue, action: decision.action, reason: decision.reason, result }
  }

  /** An unanswered ask is parked; an answered one is acted on from the answer. */
  private answeredAsk(last: StoredEvent | undefined): { question: string; answer: string } | null {
    if (last?.type !== 'triage.decision' || last.action !== 'ask') return null
    const questionId = last.questionId
    if (questionId === undefined) return null
    const q = this.store.question(questionId)
    if (q === null || q.answer === null) return null
    return { question: q.question, answer: q.answer }
  }

  /**
   * Every unclaimed task not currently held by a worker. Leaves are triaged
   * once; a container is re-triaged when its children have all closed, so a
   * finished epic gets closed instead of re-decomposed.
   */
  private async pickCandidate(): Promise<BeadsIssue | null> {
    const all = await this.tracker.list(500)
    const running = new Set(
      this.store
        .tasks({ limit: 1000 })
        .filter((t) => !isTerminal(t.state))
        .map((t) => t.id),
    )
    const candidates: BeadsIssue[] = []
    for (const issue of all) {
      if (issue.status === 'closed' || issue.status === 'in_progress') continue
      if (running.has(issue.id)) continue
      if (await this.handled(issue)) continue
      candidates.push(issue)
    }
    candidates.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || a.id.localeCompare(b.id))
    return candidates[0] ?? null
  }

  private lastDecision(id: string): StoredEvent | undefined {
    let last: StoredEvent | undefined
    for (const event of this.store.events({ taskId: id, limit: 1000 })) {
      if (event.type === 'triage.decision') last = event
    }
    return last
  }

  private async handled(issue: BeadsIssue): Promise<boolean> {
    const last = this.lastDecision(issue.id)
    if (last?.type !== 'triage.decision') return false
    if (last.action === 'ask') return this.answeredAsk(last) === null
    // A decomposed container is re-triaged only once every child has closed,
    // so a finished epic gets closed instead of being decomposed again.
    if (last.action === 'decompose') {
      const children = await this.tracker.children(issue.id)
      return children.some((c) => c.status !== 'closed')
    }
    return true
  }

  private async contextFor(issue: BeadsIssue): Promise<TriagePromptContext> {
    const [children, issueDetail] = await Promise.all([
      this.tracker.children(issue.id).catch(() => []),
      this.tracker.getIssue(issue.id).catch(() => null),
    ])
    const toView = (i: BeadsIssue): TriageTaskView => ({
      id: i.id,
      title: i.title,
      description: i.description,
      type: i.type,
      status: i.status,
      priority: i.priority,
      labels: i.labels,
      parent: i.parent,
      assignee: i.assignee,
      childCount: i.childCount,
    })
    return {
      task: toView(issueDetail ?? issue),
      children: children.map(toView),
      dependencies: issueDetail?.dependencies ?? [],
    }
  }

  /** Runs the triage harness once and parses its decision; null means ask the operator. */
  private async decide(
    issue: BeadsIssue,
    context: TriagePromptContext,
  ): Promise<TriageDecision | null> {
    const cwd = tmpdir()
    const opts = {
      cwd,
      prompt: triagePrompt(context),
      systemPrompt: triageSystemPrompt(),
      ...harnessStartOpts(this.config.harness.triage),
      env: { AMAGI_TASK_TOKEN: this.store.token(issue.id) },
    }
    const proc = this.harness.start(opts)
    const model = proc.model ?? opts.model ?? null
    const effort = proc.effort ?? null
    let started = false
    for await (const event of proc.events()) {
      if (!started) {
        started = true
        this.store.append(issue.id, {
          type: 'agent.started',
          role: 'triage',
          harness: this.harness.kind,
          model,
          effort,
          cwd,
          resumed: false,
        })
      }
      this.store.append(issue.id, { type: 'agent.stream', role: 'triage', event })
    }
    const outcome = await proc.done
    this.store.append(issue.id, {
      type: 'agent.exited',
      role: 'triage',
      exitCode: outcome.exitCode,
      sessionId: outcome.sessionId,
    })
    if (!outcome.ok) {
      this.store.append(issue.id, {
        type: 'error',
        message: `triage agent failed: ${outcome.stderr.trim() || outcome.summary || `exit ${outcome.exitCode}`}`,
        fatal: false,
      })
      return null
    }
    return parseTriageDecision(outcome.summary ?? '')
  }

  private recordDecision(issue: BeadsIssue, decision: TriageDecision, questionId?: string): void {
    this.store.append(issue.id, {
      type: 'triage.decision',
      action: decision.action,
      reason: decision.reason,
      ...(decision.subtasks.length > 0 ? { subtasks: decision.subtasks.map((s) => s.title) } : {}),
      ...(decision.question === undefined ? {} : { question: decision.question }),
      ...(questionId === undefined ? {} : { questionId }),
    })
  }

  private async act(
    issue: BeadsIssue,
    decision: TriageDecision,
    askQuestion: Question | null,
  ): Promise<string> {
    switch (decision.action) {
      case 'implement':
        return this.actionImplement(issue)
      case 'decompose':
        return this.actionDecompose(issue, decision)
      case 'close':
        return this.actionClose(issue, decision)
      case 'ask':
        return this.actionAsk(issue, askQuestion)
      case 'skip':
        return this.actionSkip(issue, decision)
    }
  }

  /** Claim and hand to the implementation runner; the triage role never codes. */
  private async actionImplement(issue: BeadsIssue): Promise<string> {
    const now = await this.tracker.getIssue(issue.id).catch(() => null)
    if (now === null || now.status === 'closed' || now.status === 'in_progress') {
      return `implement skipped: task ${issue.id} is no longer unclaimed`
    }
    const claimed = await this.tracker.claim(issue.id)
    if (claimed === null) return `implement skipped: could not claim ${issue.id}`
    const runner = this.makeRunner({
      store: this.store,
      tracker: this.tracker,
      harness: makeHarness(this.config.harness.implement),
      config: this.config,
      repoRoot: this.repoRoot,
      repoName: this.repoName,
      ...(this.exec === undefined ? {} : { exec: this.exec }),
      ...(this.forge === undefined ? {} : { forge: this.forge }),
    })
    const outcome = await runner.runClaimed(claimed)
    const state = outcome === null ? 'no result' : outcome.state
    return `implemented: task ${issue.id} ended in state ${state}`
  }

  private async actionDecompose(issue: BeadsIssue, decision: TriageDecision): Promise<string> {
    if (!this.tracker.capabilities.create) {
      return `decompose unavailable: ${this.tracker.kind} cannot create issues`
    }
    const created: string[] = []
    for (const sub of decision.subtasks) {
      const task = await this.tracker.createTask({
        title: sub.title,
        description: sub.description,
        acceptanceCriteria: sub.acceptanceCriteria,
        priority: sub.priority,
        labels: [],
        dependencies: [],
        parent: issue.id,
      })
      created.push(task.id)
    }
    const ids = created.join(', ')
    return created.length > 0
      ? `decomposed ${issue.id} into ${created.length} subtasks: ${ids}`
      : `decompose skipped: no subtasks were defined for ${issue.id}`
  }

  private async actionClose(issue: BeadsIssue, decision: TriageDecision): Promise<string> {
    try {
      await this.tracker.close(issue.id, decision.reason)
      return `closed ${issue.id}: ${decision.reason}`
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.append(issue.id, {
        type: 'error',
        message: `triage close ${issue.id} failed: ${message}`,
        fatal: false,
      })
      return `close ${issue.id} failed: ${message}`
    }
  }

  private async actionAsk(issue: BeadsIssue, question: Question | null): Promise<string> {
    if (question === null) return `ask skipped: no question was prepared for ${issue.id}`
    let gateRef: string | null = null
    try {
      gateRef = (await this.tracker.openGate(issue.id, question)).id
    } catch (err) {
      this.store.append(issue.id, {
        type: 'error',
        message: `triage ask ${issue.id}: gate not opened: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fatal: false,
      })
    }
    this.store.append(issue.id, {
      type: 'question.asked',
      questionId: question.id,
      question: question.text,
      options: [...question.options],
      gateRef,
    })
    return `asked the operator: ${question.text}`
  }

  private async actionSkip(issue: BeadsIssue, decision: TriageDecision): Promise<string> {
    try {
      await this.tracker.comment(issue.id, `amagi triage: skipped - ${decision.reason}`)
    } catch (err) {
      this.store.append(issue.id, {
        type: 'error',
        message: `triage skip comment ${issue.id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        fatal: false,
      })
    }
    return `skipped ${issue.id}: ${decision.reason}`
  }
}

function assertTriageTracker(tracker: Tracker): TriageTracker {
  const t = tracker as TriageTracker
  if (typeof t.list !== 'function' || typeof t.children !== 'function') {
    throw new Error(
      `triage requires a tracker with list() and children(); ${tracker.kind} lacks them`,
    )
  }
  return t
}

function defaultMakeRunner(deps: RunnerDeps): TriageImplementer {
  return new Runner(deps)
}

function buildAskQuestion(issue: BeadsIssue, decision: TriageDecision): Question {
  const text =
    decision.question === undefined || decision.question.trim() === ''
      ? `What should be done with task ${issue.id} (${issue.title})?`
      : decision.question
  return {
    id: crypto.randomUUID(),
    text,
    options: decision.options.length > 0 ? decision.options : [...TriageAction.options],
  }
}
