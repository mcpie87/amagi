import { agentLogStore } from '@amagi/core/agent-log'
import { HUMAN_ONLY_LABEL } from '@amagi/core/drivers/tracker/beads'
import type { TrackerTask } from '@amagi/core/drivers/types'
import {
  type AgentEvent,
  isTerminal,
  type MergeStatus,
  type StoredEvent,
  type TaskState,
} from '@amagi/core/events'
import { MAX_PARALLEL } from '@amagi/core/limits'
import type { RunnerResource } from '@amagi/core/run-service'
import {
  activeTasks,
  chatInFlight,
  chatTurns,
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
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { Marked } from 'marked'
import type { FormEvent, ReactNode } from 'react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { AgentLogView } from './AgentLogView.tsx'
import { SessionsView } from './SessionsView.tsx'
import {
  type RepoInfo,
  RunnerProvider,
  useConnection,
  useDashboard,
  useReadyQueue,
  useRunner,
} from './store.tsx'
import { setThemePref, type ThemePref, useTheme, useThemePref } from './theme.ts'
import { EmptyState, Icon, type IconName } from './ui.tsx'

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string

function ConnectionStatus() {
  const connection = useConnection()
  const label =
    connection === 'connected'
      ? 'Live updates'
      : connection === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting'
  const tone =
    connection === 'connected'
      ? 'bg-emerald-500'
      : connection === 'reconnecting'
        ? 'bg-amber-500'
        : 'bg-fg-faint'
  return (
    <span className="connection-status" title="live connection to the amagi server">
      <span className={`connection-dot ${tone}`} />
      {label}
    </span>
  )
}

function RunnerIndicator() {
  const { status } = useRunner()
  if (status === null) {
    return <span className="runner-status">runner: unknown</span>
  }
  return (
    <span
      className="runner-status"
      title={status.running.length > 0 ? `running: ${status.running.join(', ')}` : 'idle'}
    >
      runner: {status.running.length}/{status.capacity} {status.available ? 'free' : 'busy'}
    </span>
  )
}

/**
 * The search workspace command palette: a native dialog listing tasks and
 * pages matching the query. Escape closes it natively; Enter or a click jumps
 * to the highlighted entry.
 */
function CommandPalette() {
  const { state, selected } = useDashboard()
  const navigate = useNavigate()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const open = () => {
    setQuery('')
    setIndex(0)
    dialogRef.current?.showModal()
    inputRef.current?.focus()
  }
  const close = () => dialogRef.current?.close()

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const q = query.trim().toLowerCase()
  const taskMatches =
    q === ''
      ? []
      : Object.values(state.tasks)
          .filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 8)
  const pages = [
    { to: '/', label: 'Overview' },
    { to: '/issues', label: 'Tasks' },
    { to: '/inbox', label: 'Inbox' },
    { to: '/activity', label: 'Activity' },
    { to: '/sessions', label: 'Sessions' },
    { to: '/settings', label: 'Settings' },
  ].filter((p) => q === '' || p.label.toLowerCase().includes(q))
  const results: { key: string; to: string; label: string; hint: string; task: boolean }[] = [
    ...pages.map((p) => ({
      key: `page:${p.to}`,
      to: p.to,
      label: p.label,
      hint: 'page',
      task: false,
    })),
    ...taskMatches.map((t) => ({
      key: `task:${t.id}`,
      to: `/tasks/${t.id}`,
      label: t.title,
      hint: `${t.id} · ${t.state}`,
      task: true,
    })),
  ]

  const go = (entry: (typeof results)[number]) => {
    close()
    navigate({ href: entry.to })
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (results.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((i) => (i + 1) % results.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((i) => (i - 1 + results.length) % results.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const selected = results[index]
      if (selected !== undefined) go(selected)
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Search workspace"
        onClick={open}
        className="inline-flex items-center gap-2 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-muted hover:border-line-strong hover:text-fg"
      >
        <Icon name="search" size={15} />
        <span className="hidden sm:inline">Search workspace</span>
        <kbd className="hidden rounded border border-line-strong px-1 font-mono text-[10px] sm:inline">
          ⌘K
        </kbd>
      </button>
      <dialog
        ref={dialogRef}
        onCancel={(event) => {
          event.preventDefault()
          close()
        }}
        className="command-palette"
      >
        <div className="command-input-row">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={selected === null ? 'search pages…' : 'search tasks and pages…'}
            className="command-input"
          />
        </div>
        {results.length === 0 ? (
          <p className="command-empty">No matches.</p>
        ) : (
          <ul className="command-results">
            {results.map((entry, i) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(entry)}
                  className={`command-result ${i === index ? 'is-active' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.label}</span>
                    <span className="command-hint">{entry.hint}</span>
                  </span>
                  {entry.task && <span className="command-arrow">↵</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="command-footer">↑↓ navigate · ↵ open · esc close</p>
      </dialog>
    </>
  )
}

type Dependency = {
  id: string
  title: string
  /** Tracker status of the blocker: open/in_progress/blocked/closed. */
  status: string
  /** Human-only blockers carry the `human` label and need an operator, not an agent. */
  labels: string[]
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

/** One epic from /api/repos/:repo/epics/close-eligible (bd epic close-eligible --dry-run). */
type EligibleEpic = {
  id: string
  title: string
  status: string
  totalChildren: number
  closedChildren: number
}

const ISSUE_STATES: Issue['status'][] = ['open', 'in_progress', 'blocked', 'closed']

const columnHeader: Record<Issue['status'], string> = {
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
}

const columnDot: Record<Issue['status'], string> = {
  open: 'bg-fg-faint',
  in_progress: 'bg-blue-500',
  blocked: 'bg-red-500',
  closed: 'bg-emerald-500',
}

/** Shared pill shape; the tone supplies the tint, text and ring. */
const PILL = 'inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset'

const stateBadge: Record<TaskState, string> = {
  claimed: 'bg-neutral-soft text-fg ring-neutral-edge',
  worktree_ready: 'bg-sky-soft text-sky-ink ring-sky-edge',
  implementing: 'bg-blue-soft text-blue-ink ring-blue-edge',
  awaiting_answer: 'bg-amber-soft text-amber-ink ring-amber-edge',
  checks: 'bg-violet-soft text-violet-ink ring-violet-edge',
  committed: 'bg-cyan-soft text-cyan-ink ring-cyan-edge',
  retrying: 'bg-orange-soft text-orange-ink ring-orange-edge',
  pr_open: 'bg-sky-soft text-sky-ink ring-sky-edge',
  done: 'bg-emerald-soft text-emerald-ink ring-emerald-edge',
  no_pr: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
  needs_human: 'bg-red-soft text-red-ink ring-red-edge',
  abandoned: 'bg-neutral-soft text-fg-faint ring-neutral-edge',
  cancelled: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
}

function Badge({ state }: { state: TaskState }) {
  return <span className={`${PILL} ${stateBadge[state]}`}>{state}</span>
}

const mergeTone: Record<MergeStatus, string> = {
  mergeable: 'bg-emerald-soft text-emerald-ink ring-emerald-edge',
  conflicted: 'bg-red-soft text-red-ink ring-red-edge',
  unknown: 'bg-neutral-soft text-fg-muted ring-neutral-edge',
}

const mergeLabel: Record<MergeStatus, string> = {
  mergeable: 'mergeable',
  conflicted: 'merge conflict',
  unknown: 'merge status unknown',
}

function PrStatusChip({ status }: { status: MergeStatus }) {
  return <span className={`${PILL} ${mergeTone[status]}`}>{mergeLabel[status]}</span>
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
          className="flex-1 rounded border border-line-strong bg-sunken px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || path.trim() === ''}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-on-solid disabled:opacity-50"
        >
          Add repository
        </button>
      </form>
      {result !== null && 'error' in result && (
        <p className="mt-2 text-sm text-red-ink">{result.error}</p>
      )}
      {ready && (
        <ul className="mt-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          {result.ready.map((d) => (
            <li key={d.name} className="flex gap-2 py-0.5">
              <span className={d.ok ? 'text-emerald-ink' : 'text-red-ink'}>
                {d.ok ? 'ok' : '!!'}
              </span>
              <span className="w-40 shrink-0 text-fg-muted">{d.name}</span>
              <span className="min-w-0 break-all text-fg">{d.detail ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const NAV_ITEMS: {
  to: '/' | '/board' | '/issues' | '/inbox' | '/activity' | '/sessions' | '/settings'
  label: string
  icon: IconName
}[] = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/issues', label: 'Tasks', icon: 'tasks' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

function Sidebar({ navOpen, onNavigate }: { navOpen: boolean; onNavigate: () => void }) {
  const { repos, selected, selectRepo } = useDashboard()
  const [adding, setAdding] = useState(false)

  return (
    <aside className={`sidebar ${navOpen ? 'is-open' : ''}`}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 px-5 py-4">
          <Link to="/" onClick={onNavigate} className="text-lg font-semibold tracking-tight">
            amagi
          </Link>
          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
            control room
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              activeProps={{ className: 'nav-link is-active' }}
              inactiveProps={{ className: 'nav-link' }}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          {repos !== null && repos.length > 0 && (
            <div className="mb-2">
              <label
                htmlFor="repo-select"
                className="mb-1 block text-[10px] uppercase tracking-wider text-fg-faint"
              >
                Repository
              </label>
              <select
                id="repo-select"
                value={selected ?? ''}
                onChange={(e) => selectRepo(e.target.value)}
                className="w-full rounded border border-line-strong bg-surface px-2 py-1 text-sm"
              >
                {repos.map((repo) => (
                  <option key={repo.key} value={repo.key}>
                    {readyOk(repo) ? '' : '! '}
                    {repo.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="w-full rounded border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg hover:bg-raised"
          >
            {adding ? 'Close' : '+ Add repository'}
          </button>
          {adding && (
            <div className="mt-2">
              <AddRepoForm />
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

function RootLayout() {
  const { repos } = useDashboard()
  const [navOpen, setNavOpen] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const firstRender = useRef(true)

  const openNav = () => setNavOpen(true)
  const closeNav = () => setNavOpen(false)

  // Move focus into the open navigation (and back to its trigger on close)
  // only after the DOM has committed the is-open state and the inert flag has
  // been released, so the target is actually focusable.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    if (navOpen) sidebarRef.current?.querySelector('a')?.focus()
    else openButtonRef.current?.focus()
  }, [navOpen])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeNav()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  return (
    <RunnerProvider>
      <div className="app-shell">
        <div ref={sidebarRef}>
          <Sidebar navOpen={navOpen} onNavigate={() => setNavOpen(false)} />
        </div>
        <div className="workspace" inert={navOpen}>
          <header className="app-header border-b border-line px-4 py-3 sm:px-6">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3">
              <button
                ref={openButtonRef}
                type="button"
                aria-label="Open navigation"
                className="mobile-menu-button"
                onClick={() => (navOpen ? closeNav() : openNav())}
              >
                <Icon name="menu" size={20} />
              </button>
              <div className="ml-auto flex items-center gap-3">
                <ConnectionStatus />
                <RunnerIndicator />
                <CommandPalette />
              </div>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
            {repos === null ? (
              <p className="text-fg-faint">loading repositories...</p>
            ) : repos.length === 0 ? (
              <section className="mx-auto max-w-xl pt-12">
                <h1 className="text-xl font-semibold">Add a repository to start</h1>
                <p className="mt-1 text-sm text-fg-faint">
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
      </div>
    </RunnerProvider>
  )
}

function IssueBadge({ issue }: { issue: Issue }) {
  const tone =
    issue.status === 'closed'
      ? 'bg-emerald-soft text-emerald-ink ring-emerald-edge'
      : issue.status === 'blocked'
        ? 'bg-red-soft text-red-ink ring-red-edge'
        : issue.status === 'in_progress'
          ? 'bg-blue-soft text-blue-ink ring-blue-edge'
          : 'bg-neutral-soft text-fg ring-neutral-edge'
  return <span className={`${PILL} ${tone}`}>{issue.status}</span>
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

  const input =
    'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
  const label = 'mb-1 block text-sm text-fg-muted'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg border border-line-strong bg-surface p-4"
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
        {error !== null && <p className="mt-3 text-sm text-red-ink">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || title.trim() === ''}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
          >
            {mode === 'create' ? 'Create task' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  )
}

/** The operator's call to close a finished epic; the worker never decides this. */
function CloseEpicButton({
  repo,
  epic,
  onClosed,
}: {
  repo: string
  epic: EligibleEpic
  onClosed: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = async () => {
    const reason = window.prompt(`Reason for closing ${epic.title}`)
    if (reason === null || reason.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/epics/close-eligible`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
      else onClosed()
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
        className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-emerald-500 disabled:opacity-50"
      >
        Close
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

function IssuesView() {
  const { selected } = useDashboard()
  const [issues, setIssues] = useState<Issue[]>([])
  const [eligibleEpics, setEligibleEpics] = useState<EligibleEpic[]>([])
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<Issue['status'] | 'all'>('all')
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; issue: Issue } | null>(null)
  const [refresh, setRefresh] = useState(0)
  const repoRef = useRef(selected)
  const [view, setView] = useState<IssuesViewMode>(() => {
    try {
      return localStorage.getItem('amagi:issue-view') === 'list' ? 'list' : 'kanban'
    } catch {
      // storage unavailable (private mode, blocked), keep the default
      return 'kanban'
    }
  })

  const setMode = (mode: IssuesViewMode) => {
    setView(mode)
    try {
      localStorage.setItem('amagi:issue-view', mode)
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

  useEffect(() => {
    if (selected === null) return
    fetch(`${apiBase}/api/repos/${selected}/epics/close-eligible`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        return res.json() as Promise<EligibleEpic[]>
      })
      .then(setEligibleEpics)
      // An unavailable or unreachable tracker means no epic surface, not a
      // broken tasks view: the issue fetch above reports connectivity.
      .catch(() => setEligibleEpics([]))
  }, [selected, refresh])

  const saved = () => {
    setForm(null)
    setRefresh((value) => value + 1)
  }

  const q = search.trim().toLowerCase()
  const filtered = status === 'all' ? issues : issues.filter((issue) => issue.status === status)
  const searched =
    q === ''
      ? filtered
      : filtered.filter(
          (issue) => issue.title.toLowerCase().includes(q) || issue.id.toLowerCase().includes(q),
        )

  if (selectedIssue !== null) {
    return (
      <section>
        <button
          type="button"
          onClick={() => setSelectedIssue(null)}
          className="text-sm text-sky-ink hover:underline"
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
              className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
            >
              Edit
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-fg-faint">
          {selectedIssue.id}
          {selectedIssue.parent ? ` · child of ${selectedIssue.parent}` : ''}
        </p>
        <dl className="mt-6 rounded-lg border border-line bg-surface px-4 py-3">
          <DetailRow
            label="priority"
            value={selectedIssue.priority === null ? null : `P${selectedIssue.priority}`}
          />
          <DetailRow label="type" value={selectedIssue.type} />
          <DetailRow label="assignee" value={selectedIssue.assignee} />
          <DetailRow label="labels" value={selectedIssue.labels.join(', ') || null} />
        </dl>
        <Blockers issue={selectedIssue} />
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Description
          </h2>
          <p className="whitespace-pre-wrap text-fg">
            {selectedIssue.description || 'No description.'}
          </p>
        </div>
        {selectedIssue.acceptanceCriteria !== null && (
          <div className="mt-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
              Acceptance criteria
            </h2>
            <p className="whitespace-pre-wrap text-fg">{selectedIssue.acceptanceCriteria}</p>
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-sky-600"
          />
          <span className="text-sm text-fg-faint">
            {searched.length} {searched.length === 1 ? 'task' : 'tasks'}
            {status !== 'all' && ` · ${filtered.length} shown`}
          </span>
          <div className="flex rounded-lg border border-line-strong p-0.5">
            <button
              type="button"
              aria-label="Board view"
              onClick={() => setMode('kanban')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'kanban'
                  ? 'bg-raised-strong text-fg-strong'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              Board
            </button>
            <button
              type="button"
              aria-label="List view"
              onClick={() => setMode('list')}
              className={`rounded px-2 py-1 text-sm ${
                view === 'list' ? 'bg-raised-strong text-fg-strong' : 'text-fg-muted hover:text-fg'
              }`}
            >
              List
            </button>
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
            className="rounded border border-line-strong bg-surface px-2 py-1 text-sm"
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
              className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500"
            >
              New task
            </button>
          )}
        </div>
      </div>
      {selected !== null && eligibleEpics.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-emerald-ink">
            Eligible epics ({eligibleEpics.length})
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {eligibleEpics.map((epic) => (
              <li key={epic.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{epic.title}</span>
                  <span className="block truncate text-xs text-fg-faint">
                    {epic.id} · {epic.closedChildren}/{epic.totalChildren} children done
                  </span>
                </span>
                <CloseEpicButton repo={selected} epic={epic} onClosed={saved} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {error !== null ? (
        <p className="text-red-ink">{error}</p>
      ) : view === 'kanban' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ISSUE_STATES.map((state) => {
            if (status !== 'all' && status !== state) return null
            const columnIssues = searched.filter((issue) => issue.status === state)
            return (
              <div
                key={state}
                className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
              >
                <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${columnDot[state]}`} />
                    <span className="truncate text-xs font-medium uppercase tracking-wide text-fg">
                      {columnHeader[state]}
                    </span>
                  </span>
                  <span className="rounded bg-raised px-1.5 text-xs tabular-nums text-fg-muted">
                    {columnIssues.length}
                  </span>
                </div>
                <ul className="flex flex-col gap-2 p-2">
                  {columnIssues.map((issue) => (
                    <li key={issue.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedIssue(issue)}
                        className="issue-card w-full rounded border border-line bg-sunken px-3 py-2 text-left hover:bg-raised"
                      >
                        <span className="block text-xs text-fg-faint">{issue.id}</span>
                        <span className="mt-0.5 block break-words font-medium leading-snug">
                          {issue.title}
                        </span>
                        <span className="mt-1 block text-xs text-fg-faint">
                          {[issue.priority === null ? null : `P${issue.priority}`, issue.type]
                            .filter(Boolean)
                            .join(' · ') || '\u00a0'}
                        </span>
                      </button>
                    </li>
                  ))}
                  {columnIssues.length === 0 && (
                    <li className="px-1 py-2 text-xs text-fg-dim">No tasks.</li>
                  )}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {searched.map((issue) => (
            <li key={issue.id}>
              <button
                type="button"
                onClick={() => setSelectedIssue(issue)}
                className="issue-list-row flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised"
              >
                <IssueBadge issue={issue} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{issue.title}</span>
                  <span className="block truncate text-xs text-fg-faint">
                    {issue.id}
                    {issue.priority === null ? '' : ` · P${issue.priority}`}
                    {issue.type === null ? '' : ` · ${issue.type}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {searched.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-fg-faint">
              No tasks match "{search}".
            </li>
          )}
        </ul>
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
      {message !== null && <span className="text-sm text-fg-muted">{message}</span>}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
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
  return <p className="mt-2 truncate font-mono text-xs text-fg-muted">{line.text}</p>
}

function WorkerSlot({
  taskId,
  startedAt,
  now,
  resource,
  state,
  selected,
}: {
  taskId: string | null
  startedAt: number | undefined
  /** Wall-clock snapshot, advanced by one shared 1s interval in WorkersPanel. */
  now: number
  resource?: RunnerResource | undefined
  state: DashboardState
  selected: string | null
}) {
  if (taskId === null) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface/40 px-4 py-2 text-sm text-fg-dim">
        free slot
      </div>
    )
  }
  const task = state.tasks[taskId]
  const agent = currentAgentFor(state, taskId)
  return (
    <div className="rounded-lg border border-line-strong bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {startedAt !== undefined && (
          <span className="shrink-0 font-mono tabular-nums text-sm text-fg">
            {fmtElapsed(now - startedAt)}
          </span>
        )}
        <span className={`${PILL} bg-blue-soft text-blue-ink ring-blue-edge`}>busy</span>
        <Link
          to="/tasks/$id"
          params={{ id: taskId }}
          className="flex min-w-0 items-baseline gap-x-3 hover:underline"
        >
          <span className="min-w-0 truncate font-medium">{task?.title ?? taskId}</span>
          <span className="text-xs text-fg-faint">{task?.id ?? taskId}</span>
        </Link>
        {task !== undefined && <Badge state={task.state} />}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <span>agent: {agent === null ? 'starting…' : `${agent.role}: ${agent.harness}`}</span>
        <span>model: {agent?.model ?? 'unknown'}</span>
        {resource !== undefined && (
          <>
            <span>rss: {fmtBytes(resource.rssBytes)}</span>
            <span>cpu: {fmtCpu(resource.cpuMs)}</span>
            <span>procs: {resource.processes}</span>
          </>
        )}
      </div>
      {selected !== null && <LastLogLine repo={selected} taskId={taskId} />}
    </div>
  )
}

/**
 * One row per runner slot from /api/runner, so busy agents and free capacity
 * are both visible at a glance. Busy slots draw their identity and activity
 * from the SSE projection plus the live agent log ring buffer. The summary
 * strip sums RSS/CPU/process count over the live agent trees so the operator
 * can see which runner is eating the machine.
 */
function WorkersPanel() {
  const { status } = useRunner()
  const { state, selected } = useDashboard()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (status === null) return null
  const running = status.running
  const total = running.reduce(
    (acc, id) => {
      const r = status.resources[id]
      return r === undefined
        ? acc
        : {
            processes: acc.processes + r.processes,
            rssBytes: acc.rssBytes + r.rssBytes,
            cpuMs: acc.cpuMs + r.cpuMs,
          }
    },
    { processes: 0, rssBytes: 0, cpuMs: 0 },
  )
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
        Workers ({running.length}/{status.capacity})
      </h2>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">{status.name}</span>
        <span>rss: {fmtBytes(total.rssBytes)}</span>
        <span>cpu: {fmtCpu(total.cpuMs)}</span>
        <span>procs: {total.processes}</span>
      </div>
      <div className="space-y-2">
        {Array.from({ length: status.capacity }, (_, i) => (
          <WorkerSlot
            key={i}
            taskId={running[i] ?? null}
            startedAt={running[i] === undefined ? undefined : status.startedAt[running[i]]}
            now={now}
            resource={running[i] === undefined ? undefined : status.resources[running[i]]}
            state={state}
            selected={selected}
          />
        ))}
      </div>
      {status.workers !== undefined && status.workers.length > 0 && (
        <div className="mt-2 space-y-2">
          {status.workers.map((w) => (
            <div
              key={`${w.repo}/${w.name}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface/60 px-4 py-2 text-xs text-fg-muted"
            >
              <span className={`${PILL} bg-teal-soft text-teal-ink ring-teal-edge`}>{w.name}</span>
              <span className="font-medium text-fg">{w.repo}</span>
              <span>last run: {fmtLastRun(w.lastRunAt)}</span>
              {w.error === null ? (
                w.detail !== null && w.detail !== undefined ? (
                  <span>{w.detail}</span>
                ) : (
                  <span>{w.counters.map((c) => `${c.label} ${c.value}`).join(' · ')}</span>
                )
              ) : (
                <span className="text-red-ink">error: {w.error}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * The dashboard board: ready work plus every recorded task, grouped by where
 * it sits in the run loop so the state of the whole repo is visible at a
 * glance instead of a flat list. The ready column is the tracker's unclaimed
 * FCFS queue (bd ready --sort oldest), everything else comes from the live
 * event projection.
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

function QueueView() {
  const { state } = useDashboard()
  const readyQueue = useReadyQueue()
  const allTasks = Object.values(state.tasks)

  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Queue</h1>
      <WorkersPanel />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {KANBAN_COLUMNS.map((column) => {
          const states = column.states
          const tasks =
            states === null
              ? readyQueue
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
                  ? (tasks as TrackerTask[]).map((task) => (
                      <li key={task.id}>
                        <ReadyCard task={task} />
                      </li>
                    ))
                  : (tasks as TaskView[]).map((task) => (
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

const metricTone = {
  red: { box: 'border-red-edge bg-red-soft', value: 'text-red-ink' },
  amber: { box: 'border-amber-edge bg-amber-soft', value: 'text-amber-ink' },
  none: { box: 'border-line bg-surface', value: 'text-fg-strong' },
} as const

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'red' | 'amber' }) {
  const t = metricTone[tone ?? 'none']
  return (
    <div className={`metric rounded-lg border px-4 py-3 ${t.box}`}>
      <div className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${t.value}`}>{value}</div>
    </div>
  )
}

function OverviewView() {
  const { state, selected } = useDashboard()
  const { status } = useRunner()
  const [search, setSearch] = useState('')
  const queue = activeTasks(state)
  const attention = tasksNeedingAttention(state)
  const openQuestions = Object.values(state.questions).filter((q) => q.resolvedAt === null).length

  const q = search.trim().toLowerCase()
  const visible =
    q === ''
      ? queue
      : queue.filter((t) => t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q))

  const workers = status === null ? '—' : `${status.running.length}/${status.capacity}`

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-fg-faint">Live runs, capacity and anything that needs you.</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search runs…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-sky-600"
          />
          {selected !== null && <RunButton />}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Active runs" value={String(queue.length)} />
        <Metric label="Workers busy" value={workers} />
        <Metric
          label="Needs attention"
          value={String(attention.length)}
          {...(attention.length > 0 ? { tone: 'red' as const } : {})}
        />
        <Metric
          label="Open questions"
          value={String(openQuestions)}
          {...(openQuestions > 0 ? { tone: 'amber' as const } : {})}
        />
      </div>

      <WorkersPanel />

      {attention.length > 0 && (
        <section className="mb-6">
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
                  action: (task: TaskView) => (
                    <CloseButtons repo={selected} taskId={task.id} state={task.state} />
                  ),
                })}
          />
        </section>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
          Runs ({visible.length})
        </h2>
        <Link to="/activity" className="text-sm text-sky-ink hover:underline">
          activity feed &rarr;
        </Link>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon="runs" title={q === '' ? 'No active runs' : 'No matching runs'}>
          {q === ''
            ? 'Claim the next ready issue with Run next, and it will show up here.'
            : `Nothing in the queue matches "${search}".`}
        </EmptyState>
      ) : (
        <RunList tasks={visible} showReason={false} />
      )}
    </section>
  )
}

function RunList({
  tasks,
  showReason,
  action,
  rowClass = 'run-row',
}: {
  tasks: TaskView[]
  showReason: boolean
  action?: (task: TaskView) => ReactNode
  rowClass?: string
}) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
      {tasks.map((task) => (
        <li key={task.id} className={`${rowClass} flex items-center`}>
          <Link
            to="/tasks/$id"
            params={{ id: task.id }}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 hover:bg-raised"
          >
            <Badge state={task.state} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{task.title}</span>
              <span className="block truncate text-xs text-fg-faint">{task.id}</span>
              {showReason && task.statusReason !== null && (
                <span className="block truncate text-xs text-fg-muted">{task.statusReason}</span>
              )}
              {task.state === 'retrying' && (
                <span className="block truncate text-xs text-orange-ink">
                  {task.retryAt !== null ? `retrying in ${fmtRetryIn(task.retryAt)}` : 'retrying'}
                  {task.lastError !== null && ` · ${task.lastError}`}
                </span>
              )}
            </span>
          </Link>
          {action?.(task)}
        </li>
      ))}
    </ul>
  )
}

function DetailRow({ label, value }: { label: string; value: string | ReactNode | null }) {
  if (value === null) return null
  return (
    <div className="flex gap-2 py-1">
      <dt className="w-28 shrink-0 text-fg-faint">{label}</dt>
      <dd className="min-w-0 break-all">{value}</dd>
    </div>
  )
}

/** Why a task cannot run: its dependency and human-only blockers, from issue detail. */
function Blockers({ issue }: { issue: Issue }) {
  const blocking = issue.dependencies.filter((d) => d.status !== 'closed')
  if (blocking.length === 0) return null
  const humanOnly = blocking.filter((d) => d.labels.includes(HUMAN_ONLY_LABEL))
  const dependencies = blocking.filter((d) => !d.labels.includes(HUMAN_ONLY_LABEL))

  const group = (title: string, items: Dependency[], tone: 'red' | 'amber') => (
    <div>
      <h3
        className={`mb-1 text-xs font-semibold uppercase tracking-wide ${
          tone === 'red' ? 'text-red-ink' : 'text-amber-ink'
        }`}
      >
        {title} ({items.length})
      </h3>
      <ul
        className={`rounded-lg border px-3 py-1 ${
          tone === 'red' ? 'border-red-edge bg-red-soft' : 'border-amber-edge bg-amber-soft'
        }`}
      >
        {items.map((d) => (
          <li key={d.id}>
            <Link
              to="/tasks/$id"
              params={{ id: d.id }}
              className="flex items-center gap-2 py-1 text-sm hover:underline"
            >
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  tone === 'red'
                    ? 'bg-red-soft-hover text-red-ink'
                    : 'bg-amber-soft-hover text-amber-ink'
                }`}
              >
                {d.status}
              </span>
              <span className="shrink-0 text-fg-faint">{d.id}</span>
              <span className="min-w-0 truncate text-fg">{d.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )

  return (
    <div className="mt-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-ink">
        Blocked by
      </h2>
      <p className="mb-2 text-sm text-fg-faint">
        This task cannot run until every blocker is resolved.
      </p>
      <div className="space-y-3">
        {dependencies.length > 0 && group('Dependency blockers', dependencies, 'red')}
        {humanOnly.length > 0 && group('Human-only blockers', humanOnly, 'amber')}
      </div>
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
      className="inline-flex items-center gap-1.5 text-sky-ink hover:underline"
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
  const [submitted, setSubmitted] = useState(false)

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
      else setSubmitted(true)
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
    return <p className="mt-2 text-sm text-fg-faint">answer box unavailable</p>
  }

  if (submitted) {
    return <p className="mt-2 text-sm text-emerald-ink">answered</p>
  }

  if (submitted) {
    return <p className="mt-2 text-sm text-emerald-400">answered</p>
  }

  return (
    <div className="mt-2">
      {question.options.length > 0 && (
        <div className="answer-options flex flex-wrap gap-2">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send(option)}
              className="rounded border border-amber-edge bg-amber-soft px-3 py-1 text-sm hover:bg-amber-soft-hover disabled:opacity-50"
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
          className="flex-1 rounded border border-line-strong bg-sunken px-3 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ''}
          className="rounded bg-amber-600 px-3 py-1 text-sm font-medium text-on-solid disabled:opacity-50"
        >
          Answer
        </button>
      </form>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
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
  // A retrying task is still owned by its runner, which will retry on its own;
  // reclaiming it here would hand the tracker claim to a second worker.
  if (worktree === null || isTerminal(state) || state === 'retrying') return null

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
        className="rounded border border-red-edge bg-red-soft px-3 py-1 text-sm text-red-ink hover:bg-red-soft-hover disabled:opacity-50"
      >
        Reclaim
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

/** A task the operator can still retire: in flight, parked, or stopped. */
function closable(state: TaskState): boolean {
  return !isTerminal(state) || state === 'needs_human' || state === 'no_pr' || state === 'cancelled'
}

function CloseButton({
  repo,
  taskId,
  state,
  target,
}: {
  repo: string
  taskId: string
  state: TaskState
  target: 'abandoned' | 'done'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (target === 'done' && state !== 'needs_human' && state !== 'no_pr') return null

  const close = async () => {
    const reason = window.prompt(
      target === 'done' ? 'Reason for marking this task done' : 'Reason for closing this task',
    )
    if (reason === null || reason.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim(), to: target }),
      })
      if (!res.ok) setError((await res.json())?.error ?? `HTTP ${res.status}`)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void close()}
        title={
          target === 'done'
            ? 'marks the task done when the work already existed elsewhere'
            : 'closes the task as abandoned'
        }
        className={
          target === 'done'
            ? 'rounded border border-emerald-edge bg-emerald-soft px-3 py-1 text-sm text-emerald-ink hover:bg-emerald-soft-hover disabled:opacity-50'
            : 'rounded border border-line-strong bg-raised px-3 py-1 text-sm text-fg hover:bg-raised-strong disabled:opacity-50'
        }
      >
        {target === 'done' ? 'Mark done' : 'Close'}
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

/** The two operator retire actions: close as abandoned, or mark done when the work already existed. */
function CloseButtons({ repo, taskId, state }: { repo: string; taskId: string; state: TaskState }) {
  if (!closable(state)) return null
  return (
    <div className="ml-auto flex gap-2">
      <CloseButton repo={repo} taskId={taskId} state={state} target="done" />
      <CloseButton repo={repo} taskId={taskId} state={state} target="abandoned" />
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
        title="re-claims the tracker ticket and immediately restarts the run now"
        className="rounded border border-red-edge bg-red-soft px-3 py-1 text-sm text-red-ink hover:bg-red-soft-hover disabled:opacity-50"
      >
        Retry
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

/**
 * Put a parked needs_human/no_pr task back in the tracker queue so the runner
 * can pick it up again, and tell the operator whether the runner is available
 * to do so. Unlike Retry this does not launch immediately: a requeued task
 * waits for a free slot (Run next on the queue), which is exactly why the
 * runner's availability is surfaced next to the action.
 */
function RequeueButton({
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
  const { status } = useRunner()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  if (worktree === null || (state !== 'needs_human' && state !== 'no_pr')) return null

  const requeue = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/reclaim`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setResult({ kind: 'error', text: body?.error ?? `HTTP ${res.status}` })
        return
      }
      const availability =
        status === null
          ? 'the runner is offline, so the task waits for a runner'
          : status.available
            ? 'the runner has a free slot'
            : `the runner is busy (${status.running.length}/${status.capacity})`
      setResult({
        kind: 'ok',
        text: `requeued; ${availability}. Launch it from the queue with Run next when ready.`,
      })
    } catch {
      setResult({ kind: 'error', text: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  const availability =
    status === null
      ? 'offline'
      : status.available
        ? `${status.running.length}/${status.capacity} free`
        : `busy (${status.running.length}/${status.capacity})`

  return (
    <div className="ml-auto">
      <button
        type="button"
        disabled={busy}
        onClick={() => void requeue()}
        title="releases the tracker claim and puts the task back in the queue; it waits for a free runner slot instead of launching immediately"
        className="rounded border border-amber-edge bg-amber-soft px-3 py-1 text-sm text-amber-ink hover:bg-amber-soft-hover disabled:opacity-50"
      >
        Requeue
      </button>
      <p
        className="mt-1 text-right text-xs text-fg-faint"
        title="whether the runner can pick up a requeued task"
      >
        runner: {availability}
      </p>
      {result !== null && (
        <p className={`mt-1 text-sm ${result.kind === 'ok' ? 'text-emerald-ink' : 'text-red-ink'}`}>
          {result.text}
        </p>
      )}
    </div>
  )
}

/**
 * Skip a deferred automatic retry's backoff and run it now, only meaningful
 * while the task sits in retrying (the runner owns it and is sleeping).
 */
function RetryNowButton({
  repo,
  taskId,
  state,
}: {
  repo: string
  taskId: string
  state: TaskState
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (state !== 'retrying') return null

  const retryNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${repo}/tasks/${taskId}/retry`, {
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
        onClick={() => void retryNow()}
        className="rounded border border-orange-edge bg-orange-soft px-3 py-1 text-sm text-orange-ink hover:bg-orange-soft-hover disabled:opacity-50"
      >
        Retry now
      </button>
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
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

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

function fmtCpu(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Compact fixed-width elapsed time, e.g. 0:42, 12:07, 2:41:33. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

/** Compact "x ago" for a worker's last-run stamp; empty before the first tick. */
function fmtLastRun(epochMs: number): string {
  if (epochMs <= 0) return 'never'
  const s = Math.floor((Date.now() - epochMs) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** How long until a scheduled retry fires, e.g. "in 45s". */
function fmtRetryIn(ts: number): string {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000))
  if (s <= 0) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const ATTENTION_STATES: readonly TaskState[] = ['no_pr', 'needs_human', 'abandoned', 'cancelled']

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Raw HTML from the agent is escaped, not rendered, so a prompt-injected tag cannot run.
const markdown = new Marked({
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

function Markdown({ text }: { text: string }) {
  return (
    <div className="summary-markdown" dangerouslySetInnerHTML={{ __html: markdown.parse(text) }} />
  )
}

/**
 * The tracker's full issue metadata behind a task - description, acceptance
 * criteria, priority, type, assignee, labels, parent, dependencies - fetched
 * on first expand and kept for the session.
 */
function TaskIssueDetails({ repo, issueId }: { repo: string; issueId: string }) {
  const [open, setOpen] = useState(false)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (issue === null && error === null) {
      fetch(`${apiBase}/api/repos/${repo}/issues/${issueId}`)
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
          return res.json() as Promise<Issue>
        })
        .then(setIssue)
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={toggle}
        className="rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised"
      >
        {open ? 'hide issue details' : 'show issue details'}
      </button>
      {open &&
        (error !== null ? (
          <p className="mt-3 text-sm text-red-ink">{error}</p>
        ) : issue === null ? (
          <p className="mt-3 text-sm text-fg-faint">loading issue...</p>
        ) : (
          <div className="mt-3">
            <dl className="rounded-lg border border-line bg-surface px-4 py-3">
              <DetailRow
                label="priority"
                value={issue.priority === null ? null : `P${issue.priority}`}
              />
              <DetailRow label="type" value={issue.type} />
              <DetailRow label="assignee" value={issue.assignee} />
              <DetailRow label="labels" value={issue.labels.join(', ') || null} />
              <DetailRow label="parent" value={issue.parent} />
            </dl>
            <Blockers issue={issue} />
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                Description
              </h2>
              <p className="whitespace-pre-wrap text-fg">
                {issue.description || 'No description.'}
              </p>
            </div>
            {issue.acceptanceCriteria !== null && (
              <div className="mt-6">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
                  Acceptance criteria
                </h2>
                <p className="whitespace-pre-wrap text-fg">{issue.acceptanceCriteria}</p>
              </div>
            )}
          </div>
        ))}
    </div>
  )
}

/** Why a task stopped, in plain language, when the operator actually needs it. */
function SummaryPanel({ task }: { task: TaskView }) {
  const needsHuman = task.state === 'needs_human'
  if (!needsHuman && (task.statusReason === null || !ATTENTION_STATES.includes(task.state))) {
    return null
  }
  return (
    <div
      className={`mt-6 rounded-lg border px-4 py-3 ${
        needsHuman ? 'border-red-edge bg-red-soft' : 'border-amber-edge bg-amber-soft'
      }`}
    >
      <h2
        className={`text-sm font-semibold uppercase tracking-wide ${
          needsHuman ? 'text-red-ink' : 'text-amber-ink'
        }`}
      >
        {needsHuman ? 'Needs human attention' : 'Summary'}
      </h2>
      {task.statusReason !== null && <Markdown text={task.statusReason} />}
    </div>
  )
}

/** A task deferring an automatic retry: when it fires and why, plus the reason. */
function RetryPanel({ task }: { task: TaskView }) {
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
        <p className="mt-1 text-sm text-fg-muted">
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
 */
function ChatPanel({ repo, taskId }: { repo: string; taskId: string }) {
  const { state } = useDashboard()
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
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
    if (message === '' || responding) return
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
        {messages.length === 0 && (
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
      {error !== null && <p className="mt-1 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

type DetailTab = 'log' | 'checks'

function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const { state, selected } = useDashboard()
  const task: TaskView | undefined = state.tasks[id]
  const questions = openQuestionsFor(state, id)
  const currentAgent = currentAgentFor(state, id)
  const [tab, setTab] = useState<DetailTab>('log')
  const usageEvents = state.events
    .filter((e): e is AgentStreamEvent => e.taskId === id && e.type === 'agent.stream')
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
    ...(task.checks !== null
      ? [{ key: 'checks', label: `Checks ${task.checksOk ? '(passed)' : '(failed)'}` } as const]
      : []),
  ]

  return (
    <section>
      <Link to="/" className="text-sm text-sky-ink hover:underline">
        &larr; overview
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{task.title}</h1>
        <Badge state={task.state} />
        {selected !== null && (
          <ReclaimButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && (
          <RetryButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && (
          <RequeueButton
            repo={selected}
            taskId={task.id}
            state={task.state}
            worktree={task.worktree}
          />
        )}
        {selected !== null && (
          <RetryNowButton repo={selected} taskId={task.id} state={task.state} />
        )}
        {selected !== null && <CloseButtons repo={selected} taskId={task.id} state={task.state} />}
        <StopButton taskId={task.id} />
      </div>
      <p className="mt-1 text-sm text-fg-faint">{task.id}</p>

      <SummaryPanel task={task} />

      <RetryPanel task={task} />

      {selected !== null &&
        task.state === 'no_pr' &&
        task.statusReason !== null &&
        task.sessionId !== null &&
        task.worktree !== null && <ChatPanel repo={selected} taskId={task.id} />}

      <dl className="mt-6 rounded-lg border border-line bg-surface px-4 py-3">
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

      {selected !== null && <TaskIssueDetails repo={selected} issueId={task.id} />}

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
        {tab === 'log' && selected !== null && <AgentLogView repo={selected} taskId={id} />}
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

function InboxView() {
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
                  action: (task: TaskView) => (
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

type ActivityItem = {
  key: string
  ts: number
  taskId: string | null
  text: string
  icon: IconName
  tone: 'normal' | 'red' | 'amber' | 'green'
}

/** Fold the event log into a human-readable feed; agent.stream lines are skipped as noise. */
function activityItems(state: DashboardState): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const event of state.events) {
    switch (event.type) {
      case 'task.claimed':
        items.push({
          key: `c${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `claimed "${event.title}"`,
          icon: 'runs',
          tone: 'normal',
        })
        break
      case 'claim.rejected':
        items.push({
          key: `r${event.seq}`,
          ts: event.ts,
          taskId: null,
          text: `claim rejected: ${event.reason}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'task.state':
        items.push({
          key: `s${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `${event.from ?? '?'} → ${event.to}`,
          icon: 'arrow',
          tone: 'normal',
        })
        break
      case 'task.reclaimed':
        items.push({
          key: `tr${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'reclaimed',
          icon: 'refresh',
          tone: 'normal',
        })
        break
      case 'worktree.created':
        items.push({
          key: `w${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `worktree created (${event.branch})`,
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'worktree.removed':
        items.push({
          key: `wr${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'worktree removed',
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'chat.message':
        items.push({
          key: `m${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `chat: ${event.text}`,
          icon: 'agent',
          tone: 'normal',
        })
        break
      case 'agent.started':
        items.push({
          key: `a${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `agent started (${event.harness}${event.model ? `, ${event.model}` : ''}, ${event.role})`,
          icon: 'agent',
          tone: 'normal',
        })
        break
      case 'agent.exited':
        items.push({
          key: `x${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `agent exited (code ${event.exitCode})`,
          icon: 'clock',
          tone: event.exitCode === 0 ? 'green' : 'red',
        })
        break
      case 'checks.finished':
        items.push({
          key: `k${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `checks ${event.ok ? 'passed' : 'failed'} (${event.results.length})`,
          icon: 'check',
          tone: event.ok ? 'green' : 'red',
        })
        break
      case 'commit.created':
        items.push({
          key: `cm${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `commit ${event.sha.slice(0, 7)}`,
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'pr.created':
        items.push({
          key: `p${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `PR #${event.number} opened`,
          icon: 'external',
          tone: 'green',
        })
        break
      case 'question.asked':
        items.push({
          key: `q${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `asked: ${event.question}`,
          icon: 'inbox',
          tone: 'amber',
        })
        break
      case 'question.answered':
        items.push({
          key: `qa${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `answered (${event.via}): ${event.answer}`,
          icon: 'inbox',
          tone: 'green',
        })
        break
      case 'question.timedout':
        items.push({
          key: `qt${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'question timed out',
          icon: 'clock',
          tone: 'red',
        })
        break
      case 'question.parked':
        items.push({
          key: `qp${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'question parked',
          icon: 'inbox',
          tone: 'amber',
        })
        break
      case 'retry.scheduled':
        items.push({
          key: `y${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `retry #${event.attempt} in ${(event.delayMs / 1000).toFixed(0)}s`,
          icon: 'refresh',
          tone: 'amber',
        })
        break
      case 'notify.sent':
        items.push({
          key: `n${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `notified via ${event.channel}: ${event.title}`,
          icon: 'activity',
          tone: 'normal',
        })
        break
      case 'error':
        items.push({
          key: `e${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `error: ${event.message}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'agent.stream':
        break
    }
  }
  return items.reverse().slice(0, 200)
}

const activityTone: Record<ActivityItem['tone'], string> = {
  normal: 'text-fg-muted',
  red: 'text-red-ink',
  amber: 'text-amber-ink',
  green: 'text-emerald-ink',
}

function ActivityView() {
  const { state } = useDashboard()
  const items = useMemo(() => activityItems(state), [state])
  return (
    <section>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="text-sm text-fg-faint">Everything that happened across runs, newest first.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="activity" title="No activity yet">
          Claims, state changes, checks, commits and pull requests land here as runs progress.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((item) => {
            const inner = (
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className={`shrink-0 ${activityTone[item.tone]}`}>
                  <Icon name={item.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {item.text}
                  {item.taskId !== null && (
                    <span className="text-fg-faint">{` · ${item.taskId}`}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-fg-faint">
                  {fmtAgo(item.ts)}
                </span>
              </span>
            )
            return (
              <li key={item.key} className="activity-item px-4 py-2.5 text-sm">
                {item.taskId !== null ? (
                  <Link
                    to="/tasks/$id"
                    params={{ id: item.taskId }}
                    className="flex w-full items-center hover:bg-raised"
                  >
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function Appearance() {
  const pref = useThemePref()
  const theme = useTheme()

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-1 text-sm text-fg-muted">Theme</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Stored in this browser only.
        {pref === 'system' ? ` System follows your OS appearance, currently ${theme}.` : ''}
      </p>
      <div className="inline-flex gap-1 rounded border border-line-strong p-1">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={pref === option.value}
            onClick={() => setThemePref(option.value)}
            className={`rounded px-3 py-1 text-sm ${
              pref === option.value
                ? 'bg-raised text-fg-strong'
                : 'text-fg-muted hover:bg-raised hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SettingsView() {
  const { selected } = useDashboard()
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (selected === null) return
    setLoaded(false)
    setMessage(null)
    fetch(`${apiBase}/api/repos/${selected}/settings`)
      .then((res) => (res.ok ? (res.json() as Promise<{ maxParallel: number }>) : null))
      .then((body) => {
        setLoaded(true)
        setValue(body === null ? '' : String(body.maxParallel))
      })
      .catch(() => setLoaded(true))
  }, [selected])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (selected === null || busy) return
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARALLEL) {
      setMessage({
        kind: 'error',
        text: `workers must be an integer between 1 and ${MAX_PARALLEL}`,
      })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${selected}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxParallel: n }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setMessage({ kind: 'error', text: body?.error ?? `HTTP ${res.status}` })
        return
      }
      setMessage({ kind: 'ok', text: `saved: up to ${n} concurrent workers` })
    } catch {
      setMessage({ kind: 'error', text: 'could not reach the amagi server' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="max-w-xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Appearance />
      {selected === null ? (
        <p className="mt-6 text-fg-faint">no repository selected</p>
      ) : (
        <form onSubmit={save} className="mt-6 rounded-lg border border-line bg-surface p-4">
          <label htmlFor="max-workers" className="mb-1 block text-sm text-fg-muted">
            Concurrent workers
          </label>
          <p className="mb-3 text-sm text-fg-faint">
            How many tasks run at once for {selected}. Applied live; in-flight runs are unaffected.
          </p>
          <div className="flex items-center gap-2">
            <input
              id="max-workers"
              type="number"
              min={1}
              max={MAX_PARALLEL}
              step={1}
              value={value}
              disabled={!loaded}
              onChange={(e) => setValue(e.target.value)}
              className="w-28 rounded border border-line-strong bg-sunken px-3 py-1.5 text-sm"
            />
            <button
              type="submit"
              disabled={busy || !loaded}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
            >
              Save
            </button>
          </div>
          {message !== null && (
            <p
              className={`mt-3 text-sm ${message.kind === 'ok' ? 'text-emerald-ink' : 'text-red-ink'}`}
            >
              {message.text}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewView,
})
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  component: QueueView,
})
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues',
  component: IssuesView,
})
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  component: InboxView,
})
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  component: ActivityView,
})
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsView,
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsView,
})
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  issuesRoute,
  inboxRoute,
  activityRoute,
  sessionsRoute,
  settingsRoute,
  taskRoute,
])
export const router = createRouter({ routeTree })
