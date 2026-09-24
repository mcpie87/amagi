import { type ProjectedTask, tasksNeedingAttention } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useDashboard } from '../store.tsx'
import { EmptyState } from '../ui.tsx'
import { RunList } from './overview.tsx'
import { AnswerBox, CloseButtons } from './task-actions.tsx'

export function InboxView() {
  const { state, selected } = useDashboard()
  const attention = tasksNeedingAttention(state)
  const questions = Object.values(state.questions)
    .filter((q) => q.resolvedAt === null)
    .sort((a, b) => a.askedAt - b.askedAt)

  return (
    <section>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Inbox</h1>
        <p className="text-sm text-fg-faint">
          {questions.length > 0 || attention.length > 0
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

      {questions.length === 0 && attention.length === 0 && (
        <EmptyState icon="check" title="All clear">
          No open questions and no task waiting on a human.
        </EmptyState>
      )}
    </section>
  )
}
