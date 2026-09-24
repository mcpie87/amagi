import type { TrackerTask } from '@amagi/core/drivers/types'
import type { TaskState } from '@amagi/core/events'
import type { ProjectedTask } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { Badge, mergeLabel } from '../badges.tsx'
import { fmtRetryIn } from '../format.ts'
import { useDashboard, useReadyQueue } from '../store.tsx'
import { WorkersPanel } from './workers.tsx'

/**
 * The dashboard board: ready work plus every recorded task, grouped by where
 * it sits in the run loop so the state of the whole repo is visible at a
 * glance instead of a flat list. The ready column combines the tracker's
 * unclaimed FCFS queue with reclaimed tasks waiting for a claim.
 */
type KanbanColumn = {
  key: string
  title: string
  accent: string
  /** null = the tracker's ready queue; otherwise the projected states it groups. */
  states: readonly TaskState[] | null
}

const KANBAN_COLUMNS: KanbanColumn[] = [
  { key: 'ready', title: 'Ready', accent: 'bg-zinc-600', states: null },
  {
    key: 'implementing',
    title: 'In progress',
    accent: 'bg-blue-600',
    states: ['claimed', 'worktree_ready', 'implementing', 'awaiting_answer', 'checks'],
  },
  {
    key: 'retrying',
    title: 'Retrying',
    accent: 'bg-orange-600',
    states: ['retrying'],
  },
  {
    key: 'needs_human',
    title: 'Needs human',
    accent: 'bg-red-600',
    states: ['needs_human', 'abandoned', 'cancelled'],
  },
  { key: 'no_pr', title: 'No PR', accent: 'bg-amber-600', states: ['no_pr'] },
  { key: 'committed', title: 'Committed', accent: 'bg-cyan-600', states: ['committed'] },
  { key: 'pr_open', title: 'PR open', accent: 'bg-sky-600', states: ['pr_open'] },
  { key: 'done', title: 'Done', accent: 'bg-emerald-600', states: ['done'] },
]

/** One waiting task from the tracker's FCFS ready queue. */
function ReadyCard({ task }: { task: TrackerTask }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950 px-3 py-2">
      <span className="block text-xs text-zinc-500">{task.id}</span>
      <span className="mt-0.5 block break-words font-medium leading-snug">{task.title}</span>
      <span className="mt-1 block text-xs text-zinc-500">
        {[task.priority === null ? null : `P${task.priority}`, task.type]
          .filter(Boolean)
          .join(' · ') || '\u00a0'}
      </span>
    </div>
  )
}

function QueuedCard({ task }: { task: ProjectedTask }) {
  return (
    <Link
      to="/tasks/$id"
      params={{ id: task.id }}
      className="block rounded border border-zinc-800 bg-zinc-950 px-3 py-2 hover:bg-zinc-800"
    >
      <span className="flex items-center gap-1">
        <Badge state={task.state} />
        <span className="text-xs text-zinc-500">{task.id}</span>
      </span>
      <span className="mt-1 block break-words font-medium leading-snug">{task.title}</span>
    </Link>
  )
}

export function QueueView() {
  const { state } = useDashboard()
  const readyQueue = useReadyQueue()
  const allTasks = Object.values(state.tasks)
  const queuedTasks = allTasks.filter((task) => task.state === 'queued')
  const queuedIds = new Set(queuedTasks.map((task) => task.id))

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Queue</h1>
      <WorkersPanel />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {KANBAN_COLUMNS.map((column) => {
          const states = column.states
          const tasks =
            states === null
              ? [...readyQueue.filter((task) => !queuedIds.has(task.id)), ...queuedTasks]
              : allTasks
                  .filter((t) => (states as readonly TaskState[]).includes(t.state))
                  .sort((a, b) => b.updatedAt - a.updatedAt)
          return (
            <div
              key={column.key}
              className="flex min-w-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900"
            >
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
                <span
                  className={`truncate rounded px-2 py-0.5 text-xs font-medium text-white ${column.accent}`}
                >
                  {column.title}
                </span>
                <span className="text-xs text-zinc-500">{tasks.length}</span>
              </div>
              <ul className="flex flex-col gap-2 p-2">
                {column.states === null
                  ? readyQueue
                      .filter((task) => !queuedIds.has(task.id))
                      .map((task) => (
                        <li key={task.id}>
                          <ReadyCard task={task} />
                        </li>
                      ))
                  : (tasks as ProjectedTask[]).map((task) => (
                      <li key={task.id}>
                        <Link
                          to="/tasks/$id"
                          params={{ id: task.id }}
                          className="block rounded border border-zinc-800 bg-zinc-950 px-3 py-2 hover:bg-zinc-800"
                        >
                          <span className="flex items-center gap-1">
                            <Badge state={task.state} />
                            <span className="text-xs text-zinc-500">{task.id}</span>
                          </span>
                          <span className="mt-1 block break-words font-medium leading-snug">
                            {task.title}
                          </span>
                          {task.statusReason !== null &&
                            (column.key === 'needs_human' || column.key === 'no_pr') && (
                              <span className="mt-1 block truncate text-xs text-zinc-400">
                                {task.statusReason}
                              </span>
                            )}
                          {column.key === 'retrying' && (
                            <span className="mt-1 block truncate text-xs text-orange-300">
                              {task.retryAt !== null
                                ? `retries in ${fmtRetryIn(task.retryAt)}`
                                : 'retry pending'}
                              {task.lastError !== null && ` · ${task.lastError}`}
                            </span>
                          )}
                          {task.prMergeStatus !== null && task.prMergeStatus !== 'unknown' && (
                            <span
                              className={`mt-1 block truncate text-xs ${
                                task.prMergeStatus === 'conflicted'
                                  ? 'text-red-400'
                                  : 'text-emerald-400'
                              }`}
                            >
                              PR {mergeLabel[task.prMergeStatus]}
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                {column.states === null &&
                  queuedTasks.map((task) => (
                    <li key={task.id}>
                      <QueuedCard task={task} />
                    </li>
                  ))}
                {tasks.length === 0 && (
                  <li className="px-1 py-2 text-xs text-zinc-600">Nothing here.</li>
                )}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
