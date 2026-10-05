import { HUMAN_ONLY_LABEL } from '@amagi/core/drivers/tracker/beads'
import { Link } from '@tanstack/react-router'
import type { Dependency, Issue } from './issue-model.ts'

const DEPENDENCY_TONE = {
  red: {
    heading: 'text-red-ink',
    list: 'border-red-edge bg-red-soft',
    chip: 'bg-red-soft-hover text-red-ink',
  },
  amber: {
    heading: 'text-amber-ink',
    list: 'border-amber-edge bg-amber-soft',
    chip: 'bg-amber-soft-hover text-amber-ink',
  },
  emerald: {
    heading: 'text-emerald-ink',
    list: 'border-emerald-edge bg-emerald-soft',
    chip: 'bg-emerald-soft-hover text-emerald-ink',
  },
} as const

function DependencyList({
  items,
  tone,
}: {
  items: Dependency[]
  tone: keyof typeof DEPENDENCY_TONE
}) {
  return (
    <ul className={`rounded-lg border px-3 py-1 ${DEPENDENCY_TONE[tone].list}`}>
      {items.map((d) => (
        <li key={d.id}>
          <Link
            to="/issues"
            search={{ issue: d.id }}
            className="flex items-center gap-2 py-1 text-sm hover:underline"
          >
            <span className={`rounded px-1.5 py-0.5 text-xs ${DEPENDENCY_TONE[tone].chip}`}>
              {d.status}
            </span>
            <span className="shrink-0 text-fg-faint">{d.id}</span>
            <span className="min-w-0 truncate text-fg">{d.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Why a task cannot run: the open issues it waits on, split by who resolves them. */
export function Blockers({ issue }: { issue: Issue }) {
  const blocking = issue.dependencies.filter((d) => d.status !== 'closed')
  if (blocking.length === 0) return null
  const humanOnly = blocking.filter((d) => d.labels.includes(HUMAN_ONLY_LABEL))
  const tasks = blocking.filter((d) => !d.labels.includes(HUMAN_ONLY_LABEL))

  const group = (title: string, items: Dependency[], tone: 'red' | 'amber') => (
    <div>
      <h3
        className={`mb-1 text-xs font-semibold uppercase tracking-wide ${DEPENDENCY_TONE[tone].heading}`}
      >
        {title} ({items.length})
      </h3>
      <DependencyList items={items} tone={tone} />
    </div>
  )

  return (
    <div className="mt-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-ink">
        Blocked by
      </h2>
      <p className="mb-2 text-sm text-fg-faint">
        This task cannot run until every blocker is closed.
      </p>
      <div className="space-y-3">
        {tasks.length > 0 && group('Tasks', tasks, 'red')}
        {humanOnly.length > 0 && group('Human-only', humanOnly, 'amber')}
      </div>
    </div>
  )
}

/** The open issues waiting on this one: closing it lets them run. */
export function Unblocks({ issue }: { issue: Issue }) {
  const waiting = (issue.dependents ?? []).filter((d) => d.status !== 'closed')
  if (waiting.length === 0) return null
  return (
    <div className="mt-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-emerald-ink">
        Unblocks ({waiting.length})
      </h2>
      <p className="mb-2 text-sm text-fg-faint">Closing this task lets these run.</p>
      <DependencyList items={waiting} tone="emerald" />
    </div>
  )
}
