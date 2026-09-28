import { type ProjectedTask, tasksNeedingAttention } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useDashboard } from '../store.tsx'
import { EmptyState } from '../ui.tsx'
import { type Issue, isHumanOnlyIssue } from './issue-model.ts'
import { RunList } from './overview.tsx'
import { AnswerBox, CloseButtons } from './task-actions.tsx'

export function InboxView() {
  const { state, selected } = useDashboard()
  const attention = tasksNeedingAttention(state)
  const [humanIssues, setHumanIssues] = useState<Issue[]>([])
  const [humanIssuesError, setHumanIssuesError] = useState<string | null>(null)
  const [humanIssuesLoading, setHumanIssuesLoading] = useState(false)
  const questions = Object.values(state.questions)
    .filter((q) => q.resolvedAt === null)
    .sort((a, b) => a.askedAt - b.askedAt)

  useEffect(() => {
    if (selected === null) {
      setHumanIssues([])
      setHumanIssuesLoading(false)
      setHumanIssuesError(null)
      return
    }
    let active = true
    setHumanIssues([])
    setHumanIssuesLoading(true)
    setHumanIssuesError(null)
    fetch(`${apiBase}/api/repos/${selected}/issues`)
      .then(async (response) => {
        if (response.status === 501) return []
        if (!response.ok)
          throw new Error((await response.json()).error ?? `HTTP ${response.status}`)
        return ((await response.json()) as Issue[]).filter(isHumanOnlyIssue)
      })
      .then((issues) => {
        if (active) setHumanIssues(issues)
      })
      .catch((err: unknown) => {
        if (active) setHumanIssuesError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setHumanIssuesLoading(false)
      })
    return () => {
      active = false
    }
  }, [selected])

  return (
    <section>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-fg-faint">
          {questions.length > 0 ||
          attention.length > 0 ||
          humanIssues.length > 0 ||
          humanIssuesLoading ||
          humanIssuesError !== null
            ? 'Things that need a human.'
            : 'Nothing needs you right now.'}
        </p>
      </div>

      {questions.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-ink">
            Questions ({questions.length})
          </h2>
          <ul className="space-y-2">
            {questions.map((q) => {
              const task = state.tasks[q.taskId]
              return (
                <li
                  key={q.id}
                  className="question-card rounded-lg border border-amber-edge bg-amber-soft px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to="/tasks/$id"
                        params={{ id: q.taskId }}
                        className="block truncate text-xs text-fg-muted hover:text-fg hover:underline"
                      >
                        {task?.title ?? q.taskId} · {q.taskId}
                      </Link>
                      <p className="mt-0.5 font-medium">{q.question}</p>
                    </div>
                  </div>
                  {selected !== null && (
                    <AnswerBox repo={selected} taskId={q.taskId} question={q} />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {attention.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-ink">
            Needs attention ({attention.length})
          </h2>
          <RunList
            tasks={attention}
            showReason
            rowClass="attention-row"
            {...(selected === null
              ? {}
              : {
                  action: (task: ProjectedTask) => (
                    <CloseButtons repo={selected} taskId={task.id} state={task.state} />
                  ),
                })}
          />
        </div>
      )}

      {selected !== null &&
        (humanIssuesLoading || humanIssues.length > 0 || humanIssuesError !== null) && (
          <div className="mb-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-ink">
              Human-only issues ({humanIssues.length})
            </h2>
            {humanIssuesLoading ? (
              <p className="text-sm text-fg-faint">Loading…</p>
            ) : humanIssuesError !== null ? (
              <p role="alert" className="text-sm text-red-ink">
                Could not load human-only issues: {humanIssuesError}
              </p>
            ) : (
              <ul className="divide-y divide-amber-edge rounded-lg border border-amber-edge bg-amber-soft/30">
                {humanIssues.map((issue) => (
                  <li key={issue.id}>
                    <Link
                      to="/issues"
                      search={{ issue: issue.id }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-amber-soft"
                    >
                      <span className="shrink-0 text-xs text-fg-faint">{issue.id}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
                      {issue.priority !== null && (
                        <span className="shrink-0 text-xs text-fg-faint">P{issue.priority}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

      {questions.length === 0 &&
        attention.length === 0 &&
        humanIssues.length === 0 &&
        !humanIssuesLoading &&
        humanIssuesError === null && (
          <EmptyState icon="check" title="All clear">
            No open questions and no task waiting on a human.
          </EmptyState>
        )}
    </section>
  )
}
