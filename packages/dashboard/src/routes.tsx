import { agentLogStore } from '@amagi/core/agent-log'
import { type AgentEvent, isTerminal, type StoredEvent, type TaskState } from '@amagi/core/events'
import {
  activeTasks,
  currentAgentFor,
  type DashboardState,
  openQuestionsFor,
  type QuestionView,
  type TaskView,
  tasksNeedingAttention,
} from '@amagi/core/view'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useParams,
} from '@tanstack/react-router'
import type { FormEvent, ReactNode } from 'react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AgentLogView } from './AgentLogView.tsx'
import { SessionsView } from './SessionsView.tsx'
import { type RepoInfo, RunnerProvider, useDashboard, useRunner } from './store.tsx'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

function RunnerIndicator() {
  const { status } = useRunner()
  if (status === null) {
    return <span className="connection-status">runner: unknown</span>
  }
  return (
    <span
      className="connection-status"
      title={status.running.length > 0 ? `running: ${status.running.join(', ')}` : 'idle'}
    >
      runner: {status.running.length}/{status.capacity} {status.available ? 'free' : 'busy'}
    </span>
  )
}

type Dependency = {
  id: string
  title: string
}

type Issue = {
  id: string
  title: string
  description: string
  acceptanceCriteria: string | null
  status: 'open' | 'in_progress' | 'blocked' | 'closed'
  priority: number | null
  type: string | null
  assignee: string | null
  labels: string[]
  parent: string | null
  dependencies: Dependency[]
}

const PAGE_SIZE = 10

const ISSUE_STATES: Issue['status'][] = ['open', 'in_progress', 'blocked', 'closed']

const columnHeader: Record<Issue['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
}

const columnColor: Record<Issue['status'], string> = {
  open: 'bg-zinc-600',
  in_progress: 'bg-blue-600',
  blocked: 'bg-red-600',
  closed: 'bg-emerald-600',
}

const stateBadge: Record<TaskState, string> = {
  claimed: 'bg-zinc-500',
  worktree_ready: 'bg-sky-600',
  implementing: 'bg-blue-600',
  awaiting_answer: 'bg-amber-500',
  checks: 'bg-violet-600',
  committed: 'bg-cyan-600',
  retrying: 'bg-orange-500',
  pr_open: 'bg-sky-600',
  reviewing: 'bg-purple-600',
  fixing: 'bg-blue-600',
  done: 'bg-emerald-600',
  no_pr: 'bg-zinc-600',
  needs_human: 'bg-red-600',
  abandoned: 'bg-zinc-700',
  cancelled: 'bg-zinc-600',
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

function readyOk(repo: RepoInfo): boolean {
  return repo.ready.every((d) => d.ok)
}

function AddRepoForm() {
  const { addRepo } = useDashboard()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RepoInfo | { error: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (path.trim() === '' || busy) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await addRepo(path.trim()))
    } catch {
      setResult({ error: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  const ready = result !== null && 'ready' in result
  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/path/to/repository"
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || path.trim() === ''}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:opacity-50"
        >
          Add repository
        </button>
      </form>
      {result !== null && 'error' in result && (
        <p className="mt-2 text-sm text-red-400">{result.error}</p>
      )}
      {ready && (
        <ul className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm">
          {result.ready.map((d) => (
            <li key={d.name} className="flex gap-2 py-0.5">
              <span className={d.ok ? 'text-emerald-400' : 'text-red-400'}>
                {d.ok ? 'ok' : '!!'}
              </span>
              <span className="w-40 shrink-0 text-zinc-400">{d.name}</span>
              <span className="min-w-0 break-all text-zinc-300">{d.detail ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RootLayout() {
  const { repos, selected, selectRepo } = useDashboard()
  const [adding, setAdding] = useState(false)

  return (
    <RunnerProvider>
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800 px-6 py-3">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4">
            <Link to="/" className="text-lg font-semibold tracking-tight">
              amagi
            </Link>
            {repos !== null && repos.length > 0 && (
              <>
                <nav className="flex gap-3 text-sm text-zinc-400">
                  <Link to="/" activeProps={{ className: 'text-zinc-100' }}>
                    Queue
                  </Link>
                  <Link to="/issues" activeProps={{ className: 'text-zinc-100' }}>
                    Tasks
                  </Link>
                  <Link to="/sessions" activeProps={{ className: 'text-zinc-100' }}>
                    Sessions
                  </Link>
                </nav>
                <div className="ml-auto flex items-center gap-2">
                  <RunnerIndicator />
                  <select
                    value={selected ?? ''}
                    onChange={(e) => selectRepo(e.target.value)}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                  >
                    {repos.map((repo) => (
                      <option key={repo.key} value={repo.key}>
                        {readyOk(repo) ? '' : '! '}
                        {repo.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setAdding((v) => !v)}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
                  >
                    {adding ? 'close' : '+ add'}
                  </button>
                </div>
              </>
            )}
          </div>
          {adding && (
            <div className="mx-auto mt-3 max-w-5xl">
              <AddRepoForm />
            </div>
          )}
        </header>
        <main className="mx-auto max-w-5xl px-6 py-6">
          {repos === null ? (
            <p className="text-zinc-500">loading repositories...</p>
          ) : repos.length === 0 ? (
            <section className="mx-auto max-w-xl pt-12">
              <h1 className="text-xl font-semibold">Add a repository to start</h1>
              <p className="mt-1 text-sm text-zinc-500">
                Point amagi at a git repository; its own .amagi/config.toml picks the tracker,
                forge, harness and checks. No restart needed.
              </p>
              <div className="mt-4">
                <AddRepoForm />
              </div>
            </section>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </RunnerProvider>
  )
}

function IssueBadge({ issue }: { issue: Issue }) {
  const color =
    issue.status === 'closed'
      ? 'bg-emerald-600'
      : issue.status === 'blocked'
        ? 'bg-red-600'
        : issue.status === 'in_progress'
          ? 'bg-blue-600'
          : 'bg-zinc-600'
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium text-white ${color}`}>
      {issue.status}
    </span>
  )
}

type IssuesViewMode = 'kanban' | 'list'

function IssueFormModal({
  repo,
  mode,
  initial,
  onClose,
  onSaved,
}: {
  repo: string
  mode: 'create' | 'edit'
  initial: Issue | null
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [acceptance, setAcceptance] = useState(initial?.acceptanceCriteria ?? '')
  const [priority, setPriority] = useState(
    initial?.priority === undefined || initial?.priority === null ? '' : String(initial.priority),
  )
  const [labels, setLabels] = useState((initial?.labels ?? []).join(', '))
  const [dependencies, setDependencies] = useState(
    (initial?.dependencies ?? []).map((d) => d.id).join(', '),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || title.trim() === '') return
    setBusy(true)
    setError(null)
    const payload = {
      title: title.trim(),
      description,
      acceptanceCriteria: acceptance.trim() === '' ? null : acceptance,
      priority: priority === '' ? null : Number(priority),
      labels: labels
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
      dependencies: dependencies
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    }
    try {
      const url =
        mode === 'create'
          ? `${apiBase}/api/repos/${repo}/issues`
          : `${apiBase}/api/repos/${repo}/issues/${initial?.id}`
      const res = await fetch(url, {
        method: mode === 'create' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      onSaved()
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-1 text-sm text-zinc-100'
  const label = 'mb-1 block text-sm text-zinc-400'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 p-4"
      >
        <h2 className="mb-3 text-lg font-semibold">
          {mode === 'create' ? 'New task' : `Edit ${initial?.id ?? ''}`}
        </h2>
        <div className="space-y-3">
          <div>
            <label className={label} htmlFor="issue-title">
              Title
            </label>
            <input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={input}
            />
          </div>
          <div>
            <label className={label} htmlFor="issue-description">
              Description
            </label>
            <textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className={input}
            />
          </div>
          <div>
            <label className={label} htmlFor="issue-acceptance">
              Acceptance criteria
            </label>
            <textarea
              id="issue-acceptance"
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={3}
              className={input}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="issue-priority">
                Priority
              </label>
              <select
                id="issue-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className={input}
              >
                <option value="">None</option>
                <option value="0">P0</option>
                <option value="1">P1</option>
                <option value="2">P2</option>
                <option value="3">P3</option>
                <option value="4">P4</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="issue-labels">
                Labels (comma separated)
              </label>
              <input
                id="issue-labels"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                className={input}
              />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="issue-dependencies">
              Blocked by issue ids (comma separated)
            </label>
            <input
              id="issue-dependencies"
              value={dependencies}
              onChange={(e) => setDependencies(e.target.value)}
              className={input}
              placeholder="am-abc, am-123"
            />
            <p className={label}>The task waits on these issues before it can run.</p>
          </div>
        </div>
        {error !== null && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || title.trim() === ''}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create task' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}

function IssuesView() {
  const { selected } = useDashboard()
  const [issues, setIssues] = useState<Issue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Issue['status'] | 'all'>('all')
  const [page, setPage] = useState(0)
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; issue: Issue } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const repoRef = useRef(selected)
  const [view, setView] = useState<IssuesViewMode>(() => {
    try {
      return localStorage.getItem('issues:view') === 'list' ? 'list' : 'kanban'
    } catch {
      // storage unavailable (private mode, blocked), keep the default
      return 'kanban'
    }
  })

  const setMode = (mode: IssuesViewMode) => {
    setView(mode)
    try {
      localStorage.setItem('issues:view', mode)
    } catch {
      // storage unavailable, the choice just won't persist
    }
  }

  useEffect(() => {
    if (selected === null) return
    if (repoRef.current !== selected) {
      repoRef.current = selected
      setIssues([])
      setSelectedIssue(null)
    }
    setError(null)
    fetch(`${apiBase}/api/repos/${selected}/issues`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<Issue[]>
      })
      .then((items) => {
        setIssues(items)
        setSelectedIssue((current) =>
          current === null ? null : (items.find((i) => i.id === current.id) ?? null),
        )
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [selected, refresh])

  const saved = () => {
    setForm(null)
    setRefresh((value) => value + 1)
  }

  const filtered = status === 'all' ? issues : issues.filter((issue) => issue.status === status)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  if (selectedIssue !== null) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setSelectedIssue(null)}
          className="text-sm text-sky-400 hover:underline"
        >
          &larr; tasks
        </button>
        <div className="mt-3 flex items-center gap-3">
          <h1 className="text-xl font-semibold">{selectedIssue.title}</h1>
          <IssueBadge issue={selectedIssue} />
          {selected !== null && (
            <button
              type="button"
              onClick={() => setForm({ mode: 'edit', issue: selectedIssue })}
              className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800"
            >
              Edit
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          {selectedIssue.id}
          {selectedIssue.parent ? ` · child of ${selectedIssue.parent}` : ''}
        </p>
        <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
          <DetailRow
            label="priority"
            value={selectedIssue.priority === null ? null : `P${selectedIssue.priority}`}
          />
          <DetailRow label="type" value={selectedIssue.type} />
          <DetailRow label="assignee" value={selectedIssue.assignee} />
          <DetailRow label="labels" value={selectedIssue.labels.join(', ') || null} />
        </dl>
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Description
          </h2>
          <p className="whitespace-pre-wrap text-zinc-300">
            {selectedIssue.description || 'No description.'}
          </p>
        </div>
        {selectedIssue.acceptanceCriteria !== null && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              Acceptance criteria
            </h2>
            <p className="whitespace-pre-wrap text-zinc-300">{selectedIssue.acceptanceCriteria}</p>
          </div>
        )}
        {selected !== null && form !== null && (
          <IssueFormModal
            repo={selected}
            mode={form.mode}
            initial={form.mode === 'edit' ? form.issue : null}
            onClose={() => setForm(null)}
            onSaved={saved}
          />
        )}
      </section>
    )
  }
  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-500">
            {issues.length} {issues.length === 1 ? 'task' : 'tasks'}
            {status !== 'all' && ` · ${filtered.length} shown`}
          </span>
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            <button
              type="button"
              onClick={() => setMode('kanban')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'kanban'
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Kanban
            </button>
            <button
              type="button"
              onClick={() => setMode('list')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'list' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              List
            </button>
          </div>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status)
              setPage(0)
            }}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="closed">Closed</option>
          </select>
          {selected !== null && (
            <button
              type="button"
              onClick={() => setForm({ mode: 'create' })}
              className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-sky-500"
            >
              New task
            </button>
          )}
        </div>
      </div>
      {error !== null ? (
        <p className="text-red-400">{error}</p>
      ) : view === 'kanban' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ISSUE_STATES.map((state) => {
            if (status !== 'all' && status !== state) return null
            const columnIssues = filtered.filter((issue) => issue.status === state)
            return (
              <div
                key={state}
                className="flex min-w-0 flex-col rounded-lg border border-zinc-800 bg-zinc-900"
              >
                <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
                  <span
                    className={`truncate rounded px-2 py-0.5 text-xs font-medium text-white ${columnColor[state]}`}
                  >
                    {columnHeader[state]}
                  </span>
                  <span className="text-xs text-zinc-500">{columnIssues.length}</span>
                </div>
                <ul className="flex flex-col gap-2 p-2">
                  {columnIssues.map((issue) => (
                    <li key={issue.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedIssue(issue)}
                        className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 text-left hover:bg-zinc-800"
                      >
                        <span className="block text-xs text-zinc-500">{issue.id}</span>
                        <span className="mt-0.5 block break-words font-medium leading-snug">
                          {issue.title}
                        </span>
                        <span className="mt-1 block text-xs text-zinc-500">
                          {[issue.priority === null ? null : `P${issue.priority}`, issue.type]
                            .filter(Boolean)
                            .join(' · ') || '\u00a0'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {columnIssues.length === 0 && (
                    <li className="px-1 py-2 text-xs text-zinc-600">No tasks.</li>
                  )}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
            {pageItems.map((issue) => (
              <li key={issue.id}>
                <button
                  type="button"
                  onClick={() => setSelectedIssue(issue)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800"
                >
                  <IssueBadge issue={issue} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{issue.title}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {issue.id}
                      {issue.priority === null ? '' : ` · P${issue.priority}`}
                      {issue.type === null ? '' : ` · ${issue.type}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <button
                type="button"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
              >
                &larr; prev
              </button>
              <span className="text-sm text-zinc-500">
                page {currentPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                disabled={currentPage >= pageCount - 1}
                onClick={() => setPage(currentPage + 1)}
                className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
              >
                next &rarr;
              </button>
            </div>
          )}
        </>
      )}
      {selected !== null && form !== null && (
        <IssueFormModal
          repo={selected}
          mode={form.mode}
          initial={form.mode === 'edit' ? form.issue : null}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}
    </section>
  )
}

function RunButton() {
  const { start } = useRunner()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setMessage(null)
    const res = await start()
    setBusy(false)
    setMessage(res.ok ? `run started: ${res.taskId}` : (res.error ?? 'launch failed'))
  }

  return (
    <div className="flex items-center gap-2">
      {message !== null && <span className="text-sm text-zinc-400">{message}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-sky-500 disabled:opacity-50"
      >
        Run next
      </button>
    </div>
  )
}

/** The tail of one task's ring buffer, live from the rAF-batched log store. */
function LastLogLine({ repo, taskId }: { repo: string; taskId: string }) {
  const key = `${repo}/${taskId}`
  useSyncExternalStore(
    (listener) => agentLogStore.subscribe(key, listener),
    () => agentLogStore.get(key).version,
  )
  const line = agentLogStore.get(key).at(-1)
  if (line === undefined || line.text === '') return null
  return <p className="mt-2 truncate font-mono text-xs text-zinc-400">{line.text}</p>
}

function WorkerSlot({
  taskId,
  state,
  selected,
}: {
  taskId: string | null
  state: DashboardState
  selected: string | null
}) {
  if (taskId === null) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-2 text-sm text-zinc-600">
        free slot
      </div>
    )
  }
  const task = state.tasks[taskId]
  const agent = currentAgentFor(state, taskId)
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="shrink-0 rounded bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
          busy
        </span>
        <span className="min-w-0 truncate font-medium">{task?.title ?? taskId}</span>
        <span className="text-xs text-zinc-500">{task?.id ?? taskId}</span>
        {task !== undefined && <Badge state={task.state} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>agent: {agent === null ? 'starting…' : `${agent.role}: ${agent.harness}`}</span>
        <span>model: {agent?.model ?? 'unknown'}</span>
      </div>
      {selected !== null && <LastLogLine repo={selected} taskId={taskId} />}
    </div>
  )
}

/**
 * One row per runner slot from /api/runner, so busy agents and free capacity
 * are both visible at a glance. Busy slots draw their identity and activity
 * from the SSE projection plus the live agent log ring buffer.
 */
function WorkersPanel() {
  const { status } = useRunner()
  const { state, selected } = useDashboard()
  if (status === null) return null
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Workers ({status.running.length}/{status.capacity})
      </h2>
      <div className="space-y-2">
        {Array.from({ length: status.capacity }, (_, i) => (
          <WorkerSlot
            key={i}
            taskId={status.running[i] ?? null}
            state={state}
            selected={selected}
          />
        ))}
      </div>
    </section>
  )
}

function QueueView() {
  const { state, selected } = useDashboard()
  const queue = activeTasks(state)
  const attention = tasksNeedingAttention(state)

  const taskList = (tasks: TaskView[], showReason: boolean, closable = false) => (
    <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900">
      {tasks.map((task) => (
        <li key={task.id} className="flex items-center">
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-zinc-800"
          >
            <Badge state={task.state} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{task.title}</span>
              <span className="block truncate text-xs text-zinc-500">
                {task.id}
                {task.reviewRound > 0 ? ` · review round ${task.reviewRound}` : ''}
              </span>
              {showReason && task.statusReason !== null && (
                <span className="block truncate text-xs text-zinc-400">{task.statusReason}</span>
              )}
            </span>
          </Link>
          {closable && selected !== null && (
            <CloseButton repo={selected} taskId={task.id} state={task.state} />
          )}
        </li>
      ))}
    </ul>
  )

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Queue</h1>
        {selected !== null && <RunButton />}
      </div>
      <WorkersPanel />
      {attention.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-red-400">
            Needs attention ({attention.length})
          </h2>
          {taskList(attention, true, true)}
        </div>
      )}
      {queue.length === 0 ? (
        <p className="text-zinc-500">No active tasks.</p>
      ) : (
        taskList(queue, false)
      )}
    </section>
  )
}

function DetailRow({ label, value }: { label: string; value: string | ReactNode | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

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
      className="inline-flex items-center gap-1.5 text-sky-400 hover:underline"
    >
      {isGithub ? <GithubIcon className="h-4 w-4" /> : <ForgejoIcon className="h-4 w-4" />}
      {url}
    </a>
  )
}

function AnswerBox({
  repo,
  taskId,
  question,
}: {
  repo: string
  taskId: string
  question: QuestionView
}) {
  const [token, setToken] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ token?: string }>) : null))
      .then((body) => {
        if (alive) setToken(body?.token ?? null)
      })
      .catch(() => {
        if (alive) setToken(null)
      })
    return () => {
      alive = false
    }
  }, [repo, taskId])

  const send = async (answer: string) => {
    if (token === null || answer.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${apiBase}/api/repos/${repo}/tasks/${taskId}/questions/${question.id}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
          body: JSON.stringify({ answer, via: 'web' }),
        },
      )
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send(text)
  }

  if (token === null) {
    return <p className="mt-2 text-sm text-zinc-500">answer box unavailable</p>
  }

  return (
    <div className="mt-2">
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send(option)}
              className="rounded border border-amber-700 bg-amber-900/40 px-3 py-1 text-sm hover:bg-amber-800 disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="answer"
          className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-zinc-950 disabled:opacity-50"
        >
          Answer
        </button>
      </form>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

function ReclaimButton({
  repo,
  taskId,
  state,
  worktree,
}: {
  repo: string
  taskId: string
  state: TaskState
  worktree: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (worktree === null || isTerminal(state)) return null

  const reclaim = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/reclaim`, {
        method: 'POST',
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void reclaim()}
        className="rounded border border-red-800 bg-red-950/40 px-3 py-1 text-sm text-red-300 hover:bg-red-900 disabled:opacity-50"
      >
        Reclaim
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

/** A task the operator can still retire: in flight, parked, or stopped. */
function closable(state: TaskState): boolean {
  return !isTerminal(state) || state === 'needs_human' || state === 'no_pr' || state === 'cancelled'
}

function CloseButton({ repo, taskId, state }: { repo: string; taskId: string; state: TaskState }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!closable(state)) return null

  const close = async () => {
    const reason = window.prompt('Reason for closing this task')
    if (reason === null || reason.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void close()}
        className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
      >
        Close
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

function RetryButton({
  repo,
  taskId,
  state,
  worktree,
}: {
  repo: string
  taskId: string
  state: TaskState
  worktree: string | null
}) {
  const { start } = useRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (worktree === null || (state !== 'needs_human' && state !== 'no_pr')) return null

  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/reclaim`, {
        method: 'POST',
      })
      if (!res.ok) {
        setError((await res.json())?.error ?? `HTTP ${res.status}`)
        return
      }
      // Reclaim only releases the tracker claim; actually restart the run.
      const run = await start(taskId)
      if (!run.ok) setError(run.error ?? 'run failed to start')
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void retry()}
        className="rounded border border-red-800 bg-red-950/40 px-3 py-1 text-sm text-red-300 hover:bg-red-900 disabled:opacity-50"
      >
        Retry
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  )
}

function StopButton({ taskId }: { taskId: string }) {
  const { status, stop } = useRunner()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (status === null || !status.running.includes(taskId)) return null

  const doStop = async () => {
    setBusy(true)
    setError(null)
    const res = await stop(taskId)
    setBusy(false)
    if (!res.ok) setError(res.error ?? 'stop failed')
  }

  return (
    <div className="ml-auto">
      <button type="button" className="stop-button" disabled={busy} onClick={() => void doStop()}>
        Stop
      </button>
      {error !== null && <p className="run-button-error">{error}</p>}
    </div>
  )
}

type AgentStreamEvent = Extract<StoredEvent, { type: 'agent.stream' }>

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function lineFor(event: AgentStreamEvent): string {
  const ev = event.event
  switch (ev.kind) {
    case 'text':
    case 'reasoning':
      return ev.text
    case 'tool_use':
      return `[tool] ${ev.name}`
    case 'tool_result':
      return `[${ev.ok ? 'ok' : 'FAIL'}] ${ev.name}`
    case 'usage':
      return `[usage] in=${ev.inputTokens} out=${ev.outputTokens}`
    case 'result':
      return `[result] ${ev.summary ?? (ev.ok ? 'ok' : 'failed')}`
    case 'error':
      return `[error] ${ev.message}`
  }
}

/** Plain recent log. The virtualization task (am-b2z.4) replaces this. */
function AgentLog({ events }: { events: AgentStreamEvent[] }) {
  const ref = useRef<HTMLDivElement>(null)
  // no deps on purpose: tail the log after every render, not just on mount
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  })
  return (
    <div
      ref={ref}
      className="max-h-96 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-300"
    >
      {events.map((e) => (
        <div key={e.seq} className="whitespace-pre-wrap break-words">
          {lineFor(e)}
        </div>
      ))}
    </div>
  )
}

const ATTENTION_STATES: readonly TaskState[] = ['no_pr', 'needs_human', 'abandoned', 'cancelled']

/** Why a task stopped, in plain language, when the operator actually needs it. */
function SummaryPanel({ task }: { task: TaskView }) {
  if (task.statusReason === null || !ATTENTION_STATES.includes(task.state)) return null
  return (
    <div className="mt-6 rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-300">Summary</h2>
      <p className="mt-1 text-zinc-200">{task.statusReason}</p>
    </div>
  )
}

function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const { state, selected } = useDashboard()
  const task: TaskView | undefined = state.tasks[id]
  const questions = openQuestionsFor(state, id)
  // ponytail: last 500 rendered, the virtualization task (am-b2z.4) removes the cap
  const agentEvents = state.events
    .filter((e): e is AgentStreamEvent => e.taskId === id && e.type === 'agent.stream')
    .slice(-500)
  const currentAgent = currentAgentFor(state, id)
  const usageEvents = agentEvents
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
        {selected !== null && (
          <ReclaimButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && <CloseButton repo={selected} taskId={task.id} state={task.state} />}
        {selected !== null && (
          <RetryButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        <StopButton taskId={task.id} />
      </div>
      <p className="mt-1 text-sm text-zinc-500">{task.id}</p>

      <SummaryPanel task={task} />

      <dl className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <DetailRow label="tracker" value={task.tracker} />
        <DetailRow
          label="agent"
          value={currentAgent ? `${currentAgent.role}: ${currentAgent.harness}` : null}
        />
        <DetailRow label="model" value={currentAgent?.model ?? 'unknown'} />
        <DetailRow label="effort" value={currentAgent?.effort ?? 'unknown'} />
        <DetailRow label="usage" value={usage} />
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow label="PR" value={task.prUrl === null ? null : <PrLink url={task.prUrl} />} />
        {task.lastCommit !== null && (
          <DetailRow
            label="commit"
            value={`${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.subject}`}
          />
        )}
        <DetailRow label="session" value={task.sessionId} />
        <DetailRow label="error" value={task.lastError} />
      </dl>

      {selected !== null && <AgentLogView repo={selected} taskId={id} />}

      {questions.length > 0 && selected !== null && (
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
                <AnswerBox repo={selected} taskId={id} question={q} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {agentEvents.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Agent output
          </h2>
          <AgentLog events={agentEvents} />
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
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues',
  component: IssuesView,
})
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsView,
})
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})

const routeTree = rootRoute.addChildren([indexRoute, issuesRoute, sessionsRoute, taskRoute])
export const router = createRouter({ routeTree })
