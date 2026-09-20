import type { TaskState } from '@amagi/core/events'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from '@tanstack/react-router'
import { activeTasks, openQuestionsFor, type TaskView } from './state.ts'
import { useDashboard } from './store.tsx'

const stateBadge: Record<TaskState, string> = {
  claimed: 'bg-zinc-500',
  worktree_ready: 'bg-sky-600',
  implementing: 'bg-blue-600',
  awaiting_answer: 'bg-amber-500',
  checks: 'bg-violet-600',
  committed: 'bg-cyan-600',
  pr_open: 'bg-sky-600',
  reviewing: 'bg-purple-600',
  fixing: 'bg-blue-600',
  done: 'bg-emerald-600',
  needs_human: 'bg-red-600',
  abandoned: 'bg-zinc-700',
}

function Badge({ state }: { state: TaskState }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium text-white ${stateBadge[state]}`}
    >
      {state}
    </span>
  )
}

function RootLayout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-6 py-3">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          amagi
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <Outlet />
      </main>
    </div>
  )
}

function QueueView() {
  const state = useDashboard()
  const queue = activeTasks(state)

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Queue</h1>
      {queue.length === 0 ? (
        <p className="text-zinc-500">No active tasks.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
          {queue.map((task) => (
            <li key={task.id}>
              <Link
                to="/tasks/$id"
                params={{ id: task.id }}
                className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-800"
              >
                <Badge state={task.state} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{task.title}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {task.id}
                    {task.reviewRound > 0 ? ` · review round ${task.reviewRound}` : ''}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const state = useDashboard()
  const task: TaskView | undefined = state.tasks[id]
  const questions = openQuestionsFor(state, id)

  if (!task) {
    return (
      <section>
        <Link to="/" className="text-sm text-sky-400 hover:underline">
          &larr; queue
        </Link>
        <p className="mt-4 text-zinc-500">No events yet for {id}.</p>
      </section>
    )
  }

  return (
    <section>
      <Link to="/" className="text-sm text-sky-400 hover:underline">
        &larr; queue
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <Badge state={task.state} />
        {task.reviewRound > 0 && (
          <span className="text-sm text-zinc-400">review round {task.reviewRound}</span>
        )}
      </div>
      <p className="mt-1 text-sm text-zinc-500">{task.id}</p>

      <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow label="PR" value={task.prUrl} />
        {task.lastCommit !== null && (
          <DetailRow
            label="commit"
            value={`${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.subject}`}
          />
        )}
        <DetailRow label="session" value={task.sessionId} />
        <DetailRow label="error" value={task.lastError} />
      </dl>

      {questions.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Questions
          </h2>
          <ul className="space-y-2">
            {questions.map((q) => (
              <li
                key={q.id}
                className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3"
              >
                <p className="font-medium">{q.question}</p>
                {q.options.length > 0 && (
                  <p className="mt-1 text-sm text-zinc-400">{q.options.join(' · ')}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.checks !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Checks {task.checksOk ? '(passed)' : '(failed)'}
          </h2>
          <ul className="space-y-2">
            {task.checks.map((c) => (
              <li
                key={c.command}
                className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3"
              >
                <p className="font-mono text-sm">
                  <span className={c.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                    exit {c.exitCode}
                  </span>{' '}
                  {c.command}
                </p>
                {c.output !== '' && (
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-xs text-zinc-400">
                    {c.output}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: QueueView })
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})

const routeTree = rootRoute.addChildren([indexRoute, taskRoute])
export const router = createRouter({ routeTree })
