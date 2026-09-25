import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
import { errMsg } from '@amagi/core/errors'
import {
  type AgentEvent,
  currentAttemptEvents,
  type StoredEvent,
  type TaskState,
} from '@amagi/core/events'
import { fmtDuration, fmtTokens } from '@amagi/core/format'
import {
  chatInFlight,
  chatTurns,
  currentAgentFor,
  openQuestionsFor,
  type ProjectedTask,
  runHealth,
  type StatusEntry,
  stateAtAttempt,
  statusLog,
  taskEvents,
} from '@amagi/core/view'
import { Link, useParams } from '@tanstack/react-router'
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AgentLogView } from '../AgentLogView.tsx'
import { apiBase } from '../api.ts'
import { Badge, DetailRow, PrStatusChip } from '../badges.tsx'
import { useDateFormatPref } from '../date-format.ts'
import { fmtDateTime, fmtRetryIn } from '../format.ts'
import { Markdown } from '../markdown.tsx'
import { taskRoute } from '../routes.tsx'
import { useDashboard, useRunner } from '../store.tsx'
import { Blockers, fetchIssue, type Issue, Unblocks } from './issues.tsx'
import {
  AnswerBox,
  AttemptSwitcher,
  CloseButtons,
  FileAsErrorButton,
  RecheckPrButton,
  ReclaimButton,
  ResetButton,
  RetryNowButton,
  StopButton,
} from './task-actions.tsx'

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

function ForgejoIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M16.7773 0c1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.1175a7.0759 7.0759 0 0 1 4.148-1.4205l.1176-.001 1.3385.0002c.4973-.8827 1.4434-1.4788 2.5288-1.4788 1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.319c.8827.4973 1.4788 1.4434 1.4788 2.5287 0 1.602-1.2986 2.9005-2.9005 2.9005-1.6018 0-2.9004-1.2986-2.9004-2.9005 0-1.0853.596-2.0314 1.4788-2.5287l-.0002-9.9831c0-3.887 3.1195-7.0453 6.9915-7.108l.1176-.001h1.3385C14.7458.5962 15.692 0 16.7773 0ZM7.2227 19.9052c-.6596 0-1.1943.5347-1.1943 1.1943s.5347 1.1943 1.1943 1.1943 1.1944-.5347 1.1944-1.1943-.5348-1.1943-1.1944-1.1943Zm9.5546-10.4644c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Zm0-7.7346c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Z" />
    </svg>
  )
}

function PrLink({ url }: { url: string }) {
  const isGithub = new URL(url).hostname.endsWith('github.com')
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-sky-ink hover:underline"
    >
      {isGithub ? <GithubIcon className="h-4 w-4" /> : <ForgejoIcon className="h-4 w-4" />}
      {url}
    </a>
  )
}

type AgentStreamEvent = Extract<StoredEvent, { type: 'agent.stream' }>

// States whose summary/verdict stays visible after the task settles: the
// parked states for attention, plus `done` so marking a no_pr/needs_human task
// complete does not erase the verdict the operator just recorded.
const VERDICT_STATES: readonly TaskState[] = [
  'no_pr',
  'needs_human',
  'pr_flagged',
  'abandoned',
  'cancelled',
  'done',
]

/** Beads priority scale: 0 = most urgent. Fallback keeps unknown levels legible. */
const PRIORITY_SEVERITY = ['Critical', 'High', 'Medium', 'Low', 'Backlog']

/**
 * The tracker's full issue metadata behind a task - description, acceptance
 * criteria, priority, type, assignee, labels, parent, blockers and dependents.
 */
function TaskIssueDetails({ repo, issueId }: { repo: string; issueId: string }) {
  const [issue, setIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setIssue(null)
    setError(null)
    fetchIssue(repo, issueId)
      .then((detail) => {
        if (active) setIssue(detail)
      })
      .catch((err: unknown) => {
        if (active) setError(errMsg(err))
      })
    return () => {
      active = false
    }
  }, [repo, issueId])

  return (
    <>
      <div className="mt-6 rounded-lg border border-line bg-surface px-4 py-4">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">Issue</h2>
        {error !== null ? (
          <p className="text-sm text-red-ink">{error}</p>
        ) : issue === null ? (
          <p className="text-sm text-fg-faint">loading issue...</p>
        ) : (
          <IssueBody issue={issue} />
        )}
      </div>
      {issue !== null && (
        <div className="mt-4 rounded-lg border border-line bg-surface px-4 py-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Description
          </h2>
          <Collapsible clampClass="summary-clamp" noun="description">
            <Markdown text={issue.description || 'No description.'} />
          </Collapsible>
        </div>
      )}
    </>
  )
}

function IssueBody({ issue }: { issue: Issue }) {
  return (
    <>
      <dl>
        <DetailRow
          label="priority"
          value={
            issue.priority === null
              ? null
              : `P${issue.priority} - ${PRIORITY_SEVERITY[issue.priority] ?? 'Unknown'}`
          }
        />
        <DetailRow label="type" value={issue.type} />
        <DetailRow label="assignee" value={issue.assignee} />
        <DetailRow label="labels" value={issue.labels.join(', ') || null} />
        <DetailRow label="parent" value={issue.parent} />
      </dl>
      <Blockers issue={issue} />
      <Unblocks issue={issue} />
      {issue.acceptanceCriteria !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Acceptance criteria
          </h2>
          <p className="whitespace-pre-wrap text-fg">{issue.acceptanceCriteria}</p>
        </div>
      )}
    </>
  )
}

/** Clips its content to `clampClass` with a toggle that only shows when the content overflows. */
function Collapsible({
  clampClass,
  noun,
  children,
}: {
  clampClass: string
  noun: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Measured on every render, and only while clamped: expanded, scrollHeight
  // equals clientHeight and the toggle would vanish.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el !== null && !expanded) setOverflows(el.scrollHeight > el.clientHeight)
  })
  return (
    <>
      <div ref={bodyRef} className={expanded ? undefined : clampClass}>
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-sm text-sky-ink hover:underline"
        >
          {expanded ? 'show less' : `show full ${noun}`}
        </button>
      )}
    </>
  )
}

/** Why a task stopped, in plain language, when the operator actually needs it. */
function SummaryPanel({ task }: { task: ProjectedTask }) {
  const needsHuman = task.state === 'needs_human'
  const done = task.state === 'done'
  if (!needsHuman && (task.statusReason === null || !VERDICT_STATES.includes(task.state))) {
    return null
  }
  return (
    <div
      className={`mt-6 rounded-lg border px-4 py-3 ${
        needsHuman
          ? 'border-red-edge bg-red-soft'
          : done
            ? 'border-line bg-surface'
            : 'border-amber-edge bg-amber-soft'
      }`}
    >
      <h2
        className={`text-sm font-semibold uppercase tracking-wide ${
          needsHuman ? 'text-red-ink' : done ? 'text-fg-muted' : 'text-amber-ink'
        }`}
      >
        {needsHuman ? 'Needs human attention' : done ? 'Verdict' : 'Summary'}
      </h2>
      {task.statusReason !== null && (
        <Collapsible clampClass="summary-clamp" noun="summary">
          <Markdown text={task.statusReason} />
        </Collapsible>
      )}
    </div>
  )
}

/** A task deferring an automatic retry: when it fires and why, plus the reason. */
function RetryPanel({ task }: { task: ProjectedTask }) {
  if (task.state !== 'retrying') return null
  return (
    <div className="mt-6 rounded-lg border border-orange-edge bg-orange-soft px-4 py-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-orange-ink">
        Deferred automatic retry
      </h2>
      <p className="mt-1 text-sm text-fg">
        {task.retryAt !== null
          ? `Retrying in ${fmtRetryIn(task.retryAt)} (attempt ${task.retryCount}).`
          : `Retry pending (attempt ${task.retryCount}).`}{' '}
        No human action is needed; use Retry now to skip the wait, or Close to abandon.
      </p>
      {task.lastError !== null && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-fg-muted">
          Reason: {task.lastError.replace(/^agent failed:\s*/, '')}
        </p>
      )}
    </div>
  )
}

/**
 * Operator/worker chat on a parked no_pr task. Each message resumes the task's
 * recorded session in its worktree; the answer streams in through the repo
 * event stream, so this component only renders what chatTurns folds from it.
 * A settled task (e.g. marked done) keeps the conversation read-only so it is
 * not lost on completion, while the send form only shows while the task is a
 * chattable no_pr run with a session and worktree to resume.
 */
function ChatPanel({ repo, taskId }: { repo: string; taskId: string }) {
  const { state } = useDashboard()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const task = state.tasks[taskId]
  const interactive =
    task !== undefined &&
    task.state === 'no_pr' &&
    task.statusReason !== null &&
    task.sessionId !== null &&
    task.worktree !== null
  const messages = useMemo(() => chatTurns(state, taskId), [state, taskId])
  const responding = useMemo(() => chatInFlight(state, taskId), [state, taskId])
  const scrollRef = useRef<HTMLDivElement>(null)
  // Tail the conversation after every render, like the agent log.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  })

  const send = async (event: FormEvent) => {
    event.preventDefault()
    const message = text.trim()
    if (message === '' || responding || !interactive) return
    setError(null)
    setText('')
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
        Chat with worker
      </h2>
      <div
        ref={scrollRef}
        className="mb-3 max-h-80 space-y-2 overflow-auto rounded-lg border border-line bg-sunken p-3"
      >
        {messages.length === 0 && interactive && (
          <p className="text-sm text-fg-faint">Ask the worker about why there is no PR.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'ml-auto bg-sky-600 text-on-solid'
                : 'mr-auto border border-line-strong bg-raised text-fg'
            }`}
          >
            {m.role === 'user'
              ? m.text
              : m.pending
                ? `${m.text === '' ? 'worker is responding' : m.text}...`
                : m.text}
          </div>
        ))}
      </div>
      {interactive ? (
        <form onSubmit={send} className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={responding}
            placeholder={responding ? 'worker is responding...' : 'ask the worker'}
            className="flex-1 rounded border border-line-strong bg-sunken px-3 py-1 text-sm disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={responding || text.trim() === ''}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
          >
            Send
          </button>
        </form>
      ) : (
        <p className="text-xs text-fg-faint">Conversation preserved; the task is settled.</p>
      )}
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

const REPORT_LOG_LINES = 100

/** Markdown summary of a task, ready to feed an LLM for bug-report generation. */
function taskReport(task: ProjectedTask, elapsedMs: number, repo: string): string {
  const buffer = agentLogStore.get(agentLogKey(repo, task.id, task.attempt))
  const start = Math.max(0, buffer.length - REPORT_LOG_LINES)
  const log: string[] = []
  for (let i = start; i < buffer.length; i++) {
    const line = buffer.at(i)
    if (line !== undefined) log.push(line.text)
  }
  const checks =
    task.checks === null
      ? 'none'
      : task.checksOk
        ? `passed (${task.checks.length} checks)`
        : `failed (${task.checks.length} checks)`
  const pr = task.prUrl ?? 'none'
  const branch = task.branch ?? 'none'
  const needsHuman = task.state === 'needs_human' ? ' (needs human attention)' : ''
  return [
    `# ${task.title}`,
    '',
    `- **ID**: ${task.id}`,
    `- **State**: ${task.state}${needsHuman}`,
    `- **Tracker**: ${task.tracker}`,
    `- **Branch**: ${branch}`,
    `- **PR**: ${pr}`,
    `- **Checks**: ${checks}`,
    `- **Elapsed**: ${fmtDuration(elapsedMs)}`,
    '',
    '## Summary',
    '',
    task.statusReason ?? 'none',
    '',
    `## Log (last ${log.length} lines)`,
    '',
    '```',
    ...log,
    '```',
    '',
  ].join('\n')
}

/** Header-row button that copies a markdown task report to the clipboard. */
function CopyReportButton({
  repo,
  task,
  elapsedMs,
}: {
  repo: string
  task: ProjectedTask
  elapsedMs: number
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(taskReport(task, elapsedMs, repo))
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard unavailable (non-secure context); leave the button quiet
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
    >
      {copied ? 'Copied' : 'Copy report'}
    </button>
  )
}

const STATUS_CAUSE_LABEL: Record<StatusEntry['cause'], string | null> = {
  claimed: 'claimed',
  state: null,
  reset: 'reset',
  reclaimed: 'reclaimed',
}

function StatusLogView({ entries }: { entries: StatusEntry[] }) {
  const dateFormat = useDateFormatPref()
  if (entries.length === 0) {
    return <p className="text-sm text-fg-faint">No state changes recorded yet.</p>
  }
  return (
    <ol className="status-log divide-y divide-line rounded-lg border border-line bg-surface">
      {entries.map((entry) => {
        const cause = STATUS_CAUSE_LABEL[entry.cause]
        const date = new Date(entry.ts)
        return (
          <li key={entry.seq}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <time
                dateTime={date.toISOString()}
                className="w-44 shrink-0 font-mono text-xs tabular-nums text-fg-muted"
              >
                {fmtDateTime(date, dateFormat)}
              </time>
              <Badge state={entry.to} />
              {cause !== null && <span className="text-xs text-fg-faint">{cause}</span>}
              {entry.from !== null && (
                <span className="text-xs text-fg-faint">from {entry.from}</span>
              )}
              {entry.reason !== null && (
                <span className="min-w-0 flex-1 truncate text-fg-muted" title={entry.reason}>
                  {entry.reason}
                </span>
              )}
              {entry.durationMs !== null && (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-faint">
                  {fmtDuration(entry.durationMs)}
                </span>
              )}
            </div>
            {entry.runs.length > 0 && (
              <ol className="space-y-1 pb-2 pl-12 pr-4">
                {entry.runs.map((run, index) => {
                  const model = run.model === null ? run.harness : `${run.harness}/${run.model}`
                  const details = [
                    run.durationMs === null ? null : fmtDuration(run.durationMs),
                    run.exitCode === null ? null : `exit ${run.exitCode}`,
                    `${fmtTokens(run.inputTokens)} in · ${fmtTokens(run.outputTokens)} out`,
                    run.costUsd === null ? null : `$${run.costUsd.toFixed(2)}`,
                  ].filter((part): part is string => part !== null)
                  return (
                    <li
                      key={`${run.startedAt}-${index}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"
                    >
                      <span className="text-fg-faint">
                        {index === entry.runs.length - 1 ? '└' : '├'}
                      </span>
                      <span className="font-medium text-fg">{run.label}</span>
                      <span>
                        {model}
                        {run.effort === null ? '' : ` · ${run.effort}`}
                      </span>
                      <span className="tabular-nums">{details.join(' · ')}</span>
                    </li>
                  )
                })}
              </ol>
            )}
          </li>
        )
      })}
    </ol>
  )
}

type DetailTab = 'log' | 'status' | 'checks'

export function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const { state: liveState, selected } = useDashboard()
  const { status } = useRunner()
  // null follows the current attempt, so a reset moves the view along with it.
  const [viewAttempt, setViewAttempt] = useState<number | null>(null)
  const currentAttempt = liveState.tasks[id]?.attempt ?? 1
  const attempt =
    viewAttempt !== null && viewAttempt < currentAttempt ? viewAttempt : currentAttempt
  const past = attempt < currentAttempt
  const state = useMemo(
    () => (past ? stateAtAttempt(liveState, id, attempt) : liveState),
    [past, liveState, id, attempt],
  )
  const task: ProjectedTask | undefined = state.tasks[id]
  const questions = past ? [] : openQuestionsFor(state, id)
  const currentAgent = currentAgentFor(state, id)
  const runnerTask = past ? undefined : status?.tasks?.[id]
  const [tab, setTab] = useState<DetailTab>('log')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const health = runHealth(state, id, past && task !== undefined ? task.updatedAt : now)
  const usageEvents = currentAttemptEvents(taskEvents(state, id), id)
    .filter((e): e is AgentStreamEvent => e.type === 'agent.stream')
    .map((e) => e.event)
    .filter((ev): ev is Extract<AgentEvent, { kind: 'usage' }> => ev.kind === 'usage')
  const effIn = usageEvents.reduce((sum, u) => sum + u.inputTokens, 0)
  const effOut = usageEvents.reduce((sum, u) => sum + u.outputTokens, 0)
  const effCost = usageEvents.reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  const usage =
    usageEvents.length === 0
      ? 'no usage reported yet'
      : `${fmtTokens(effIn)} in · ${fmtTokens(effOut)} out` +
        (effCost > 0 ? ` · $${effCost.toFixed(2)}` : '')

  if (!task) {
    return (
      <section>
        <Link to="/" className="text-sm text-sky-ink hover:underline">
          &larr; overview
        </Link>
        <p className="mt-4 text-fg-faint">No events yet for {id}.</p>
      </section>
    )
  }

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'log', label: 'Log' },
    { key: 'status', label: 'Status' },
    ...(task.checks !== null
      ? [{ key: 'checks', label: `Checks ${task.checksOk ? '(passed)' : '(failed)'}` } as const]
      : []),
  ]

  // The chat is live while the task is a chattable no_pr run; a settled task
  // keeps the panel only when a conversation was actually recorded, so the
  // operator does not lose it by completing the task.
  const chatAvailable =
    !past &&
    ((task.state === 'no_pr' &&
      task.statusReason !== null &&
      task.sessionId !== null &&
      task.worktree !== null) ||
      taskEvents(state, task.id).some((e) => e.type === 'chat.message'))

  return (
    <section>
      <Link to="/" className="text-sm text-sky-ink hover:underline">
        &larr; overview
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <Badge state={task.state} />
        {selected !== null && !past && (
          <ReclaimButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && !past && (
          <FileAsErrorButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            statusReason={task.statusReason}
          />
        )}
        {selected !== null && !past && (
          <ResetButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && !past && (
          <RetryNowButton repo={selected} taskId={task.id} state={task.state} />
        )}
        {selected !== null && !past && (
          <RecheckPrButton repo={selected} taskId={task.id} state={task.state} />
        )}
        {selected !== null && !past && (
          <CloseButtons repo={selected} taskId={task.id} state={task.state} />
        )}
        {selected !== null && (
          <CopyReportButton repo={selected} task={task} elapsedMs={health.elapsedMs} />
        )}
        {!past && <StopButton taskId={task.id} />}
      </div>
      <p className="mt-1 text-sm text-fg-faint">{task.id}</p>

      {selected !== null && <TaskIssueDetails repo={selected} issueId={task.id} />}

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-fg-muted">
        {currentAttempt < 2 ? 'Attempt' : 'Attempts'}
      </h2>
      <AttemptSwitcher current={currentAttempt} viewing={attempt} onSelect={setViewAttempt} />
      {past && (
        <p className="mt-2 text-sm text-fg-muted">
          Viewing attempt #{attempt}, which was reset. Actions apply to the current attempt.
        </p>
      )}

      <SummaryPanel task={task} />

      <RetryPanel task={task} />

      {selected !== null && chatAvailable && <ChatPanel repo={selected} taskId={task.id} />}

      <dl className="mt-6 rounded-lg border border-line bg-surface px-4 py-3">
        <DetailRow label="tracker" value={task.tracker} />
        <DetailRow
          label="agent"
          value={
            currentAgent
              ? `${currentAgent.role}: ${currentAgent.harness}`
              : runnerTask?.harness
                ? `implement: ${runnerTask.harness}`
                : null
          }
        />
        <DetailRow label="model" value={currentAgent?.model ?? runnerTask?.model ?? 'unknown'} />
        <DetailRow label="effort" value={currentAgent?.effort ?? runnerTask?.effort ?? 'unknown'} />
        <DetailRow label="usage" value={usage} />
        <DetailRow
          label="context"
          value={
            health.contextTokens === null
              ? 'no usage reported yet'
              : health.contextWarnTokens === null
                ? fmtTokens(health.contextTokens)
                : `${fmtTokens(health.contextTokens)} / ${fmtTokens(health.contextWarnTokens)} warn · ${fmtTokens(health.contextMaxTokens ?? 0)} max`
          }
        />
        <DetailRow
          label="cost"
          value={
            !health.costSeen
              ? 'not reported by harness'
              : health.maxCostUsd > 0
                ? `$${health.costUsd.toFixed(2)} / $${health.maxCostUsd.toFixed(2)}`
                : `$${health.costUsd.toFixed(2)}`
          }
        />
        <DetailRow
          label="elapsed"
          value={
            health.maxRunMs === null
              ? fmtDuration(health.elapsedMs)
              : `${fmtDuration(health.elapsedMs)} / ${fmtDuration(health.maxRunMs)}`
          }
        />
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow
          label="PR"
          value={
            task.prUrl === null ? null : (
              <span className="flex items-center gap-2">
                <PrLink url={task.prUrl} />
                {task.prMergeStatus !== null && <PrStatusChip status={task.prMergeStatus} />}
              </span>
            )
          }
        />
        {task.lastCommit !== null && (
          <DetailRow
            label="commit"
            value={`${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.subject}`}
          />
        )}
        <DetailRow label="session" value={task.sessionId} />
        <DetailRow label="error" value={task.lastError} />
      </dl>

      {health.warnings.length > 0 && (
        <div className="mt-4 rounded-lg border border-amber-edge bg-amber-soft px-4 py-3">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-ink">
            Guard warnings
          </h2>
          <ul className="space-y-1">
            {health.warnings.map((w, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: warnings are plain strings that may repeat.
              <li key={i} className="font-mono text-xs text-fg">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        {tabs.length > 1 && (
          <div className="detail-tabs mb-3 flex gap-1 border-b border-line">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`rounded-t px-3 py-1.5 text-sm ${
                  tab === t.key
                    ? 'border-b-2 border-sky-500 text-fg-strong'
                    : 'text-fg-muted hover:text-fg'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {tab === 'log' && selected !== null && (
          <AgentLogView repo={selected} taskId={id} attempt={attempt} />
        )}
        {tab === 'status' && <StatusLogView entries={statusLog(state, id, past ? null : now)} />}
        {tab === 'checks' && task.checks !== null && (
          <ul className="space-y-2">
            {task.checks.map((c) => (
              <li
                key={c.command}
                className="check-result rounded-lg border border-line bg-surface px-4 py-3"
              >
                <p className="font-mono text-sm">
                  <span className={c.exitCode === 0 ? 'text-emerald-ink' : 'text-red-ink'}>
                    exit {c.exitCode}
                  </span>{' '}
                  {c.command}
                </p>
                {c.output !== '' && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-sunken p-2 font-mono text-xs text-fg-muted">
                    {c.output}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {questions.length > 0 && selected !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Questions
          </h2>
          <ul className="space-y-2">
            {questions.map((q) => (
              <li
                key={q.id}
                className="rounded-lg border border-amber-edge bg-amber-soft px-4 py-3"
              >
                <p className="font-medium">{q.question}</p>
                <AnswerBox repo={selected} taskId={id} question={q} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
