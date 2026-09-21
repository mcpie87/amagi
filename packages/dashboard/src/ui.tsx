import type { TaskState } from '@amagi/core/events'
import type { ReactNode } from 'react'

const paths = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  runs: 'm9 5 11 7-11 7z M4 5v14',
  tasks: 'M9 5h12 M9 12h12 M9 19h12 M3 5h.01 M3 12h.01 M3 19h.01',
  inbox: 'M4 4h16l2 12v4H2v-4z M2 16h6l2 3h4l2-3h6',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  arrow: 'M5 12h14 m-5-5 5 5-5 5',
  branch:
    'M6 6v12 M18 6v3c0 3-3 3-6 3s-6 0-6 3 M9 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M21 3a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M9 21a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  agent: 'M5 7h14v13H5z M12 3v4 M9 12h.01 M15 12h.01 M9 16h6 M2 11v5 M22 11v5',
  external: 'M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7',
  close: 'm6 6 12 12 M6 18 18 6',
  board: 'M3 4h5v16H3z M10 4h5v11h-5z M17 4h5v14h-5z',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18a8 8 0 0 1-14-6',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  settings:
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41',
  moon: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z',
} satisfies Record<string, string>

export type IconName = keyof typeof paths

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}

export const stateLabels: Record<TaskState, string> = {
  claimed: 'Queued',
  worktree_ready: 'Preparing',
  implementing: 'Implementing',
  awaiting_answer: 'Awaiting answer',
  checks: 'Running checks',
  committed: 'Committed',
  retrying: 'Retrying',
  pr_open: 'PR open',
  reviewing: 'Reviewing',
  fixing: 'Fixing',
  done: 'Completed',
  no_pr: 'No PR needed',
  needs_human: 'Needs attention',
  abandoned: 'Abandoned',
}

export function Badge({ state }: { state: TaskState }) {
  return (
    <span className={`badge state-${state}`}>
      <span className="status-dot" />
      {stateLabels[state]}
    </span>
  )
}

export function EmptyState({
  icon = 'runs',
  title,
  children,
}: {
  icon?: IconName
  title: string
  children: ReactNode
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={25} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  )
}

export function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </div>
  )
}

export function Time({ ts }: { ts: number }) {
  const date = new Date(ts)
  const today = date.toDateString() === new Date().toDateString()
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {date.toLocaleString([], {
        ...(today ? {} : { month: 'short', day: 'numeric', year: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label className="search-field">
      <Icon name="search" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
    </label>
  )
}
