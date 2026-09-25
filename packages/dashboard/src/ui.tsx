import type { ReactNode } from 'react'
import { useDateFormatPref } from './date-format.ts'
import { fmtDateTime } from './format.ts'

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
  sessions: 'M3 5h6v14H3z M12 5h9v7h-9z M12 15h9v4h-9z',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
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

export function Time({ ts }: { ts: number }) {
  const date = new Date(ts)
  const today = date.toDateString() === new Date().toDateString()
  const dateFormat = useDateFormatPref()
  return (
    <time dateTime={date.toISOString()} title={fmtDateTime(date, dateFormat)}>
      {date.toLocaleString([], {
        ...(today ? {} : { month: 'short', day: 'numeric', year: 'numeric' }),
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  )
}
