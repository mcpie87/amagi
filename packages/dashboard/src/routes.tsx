import { isTerminal, type StoredEvent } from '@amagi/core/events'
import {
  activeTasks,
  currentAgentFor,
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
  useRouterState,
} from '@tanstack/react-router'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { AgentLogView } from './AgentLogView.tsx'
import { useConnection, useDashboard } from './store.tsx'
import { currentTheme, setTheme, type Theme } from './theme.ts'
import {
  Badge,
  EmptyState,
  Icon,
  type IconName,
  PageHeading,
  SearchField,
  stateLabels,
  Time,
} from './ui.tsx'

function taskAttentionText(task: TaskView): string {
  if (task.lastError) return task.lastError
  if (task.state === 'no_pr') {
    return 'No changes were made. Verify the task is already done, then close it explicitly.'
  }
  return 'The run stopped and needs your attention.'
}

const apiBase = (import.meta.env.VITE_API_BASE ?? '') as string
const navigation = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/runs', label: 'Runs', icon: 'runs' },
  { to: '/issues', label: 'Task board', icon: 'board' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
] as const

function RootLayout() {
  const state = useDashboard()
  const connection = useConnection()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const sidebarRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const attentionCount =
    Object.values(state.questions).filter((q) => q.resolvedAt === null).length +
    tasksNeedingAttention(state).length
  const currentPage = navigation.find((item) => item.to === pathname)?.label ?? 'Run details'

  useEffect(() => {
    if (!mobileOpen) return
    const sidebar = sidebarRef.current
    const trigger = menuRef.current
    sidebar?.querySelector<HTMLElement>('a, button')?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return
      const elements = sidebar?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')
      const first = elements?.[0]
      const last = elements?.[elements.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    const desktop = window.matchMedia('(min-width: 761px)')
    const onResize = () => {
      if (desktop.matches) setMobileOpen(false)
    }
    document.addEventListener('keydown', trapFocus)
    desktop.addEventListener('change', onResize)
    return () => {
      document.removeEventListener('keydown', trapFocus)
      desktop.removeEventListener('change', onResize)
      trigger?.focus()
    }
  }, [mobileOpen])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((value) => !value)
      }
      if (event.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      {mobileOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside ref={sidebarRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
        <button
          type="button"
          className="mobile-nav-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        >
          <Icon name="close" />
        </button>
        <Link to="/" className="brand" onClick={() => setMobileOpen(false)}>
          <span className="brand-mark">
            a<span>.</span>
          </span>
          <span>
            amagi<span className="brand-subtitle">AGENT WORKSPACE</span>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-avatar">
            <Icon name="branch" size={16} />
          </span>
          <span>
            Current workspace<small>Connected server</small>
          </span>
          <span className={`connection-dot ${connection}`} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="nav-link"
              activeOptions={{ exact: item.to === '/' }}
              activeProps={{ className: 'nav-link active', 'aria-current': 'page' }}
              onClick={() => setMobileOpen(false)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.to === '/inbox' && attentionCount > 0 && (
                <span className="nav-count">{attentionCount}</span>
              )}
              {item.to === '/runs' && (
                <span className="nav-count subtle">{activeTasks(state).length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="orbital-mark">
              <Icon name="agent" size={24} />
            </span>
            <h3>
              A little less terminal.
              <br />A lot more possibility.
            </h3>
            <p>
              Your agents work.
              <br />
              You set the direction.
            </p>
          </div>
          <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" />
            <span>Quick navigation</span>
            <kbd>⌘ / Ctrl K</kbd>
          </button>
          <div className="sidebar-footer">
            <span className="operator-avatar">O</span>
            <span>
              Operator<small>Local workspace</small>
            </span>
            <span className="local-label">LOCAL</span>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobileOpen}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              type="button"
              className="icon-button mobile-menu"
              ref={menuRef}
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{currentPage}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`connection-status ${connection}`} role="status">
              <span className="connection-dot" />
              {connection === 'connected'
                ? 'Live updates'
                : connection === 'connecting'
                  ? 'Connecting'
                  : 'Reconnecting'}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label="Search workspace"
              onClick={() => setPaletteOpen(true)}
            >
              <Icon name="search" />
            </button>
            <Link
              to="/inbox"
              className="icon-button inbox-shortcut"
              aria-label={`Inbox, ${attentionCount} items need attention`}
            >
              <Icon name="inbox" />
              {attentionCount > 0 && <span className="notification-dot" />}
            </Link>
          </div>
        </header>
        {connection === 'reconnecting' && (
          <div className="connection-banner" role="status">
            Connection interrupted. Showing the last received state while reconnecting.
          </div>
        )}
        <main id="main" className="main-content">
          <Outlet />
        </main>
        <footer className="workspace-footer">
          <span>
            amagi <span className="footer-dot">/</span> your orchestration workspace
          </span>
          <span>Built for the work ahead.</span>
        </footer>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  )
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const state = useDashboard()
  const needle = query.toLowerCase()
  const tasks = Object.values(state.tasks)
    .filter((task) => `${task.id} ${task.title}`.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
  const pages = navigation.filter((item) => item.label.toLowerCase().includes(needle))
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      onCancel={onClose}
      onClose={onClose}
      aria-label="Quick navigation"
    >
      <div className="palette-search">
        <SearchField value={query} onChange={setQuery} placeholder="Find a page or run…" />
        <button type="button" className="icon-button" aria-label="Close search" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="palette-results">
        {pages.map((item) => (
          <Link key={item.to} to={item.to} onClick={onClose}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            <Icon name="arrow" size={15} />
          </Link>
        ))}
        {tasks.length > 0 && <p className="eyebrow">RUNS</p>}
        {tasks.map((task) => (
          <Link key={task.id} to="/tasks/$id" params={{ id: task.id }} onClick={onClose}>
            <Icon name="runs" />
            <span>
              {task.title}
              <small>{task.id}</small>
            </span>
            <Badge state={task.state} />
          </Link>
        ))}
        {pages.length === 0 && tasks.length === 0 && (
          <p className="muted palette-empty">No pages or runs match “{query}”.</p>
        )}
      </div>
      <div className="palette-footer">
        Tab to navigate <span>Enter to open · Esc to close</span>
      </div>
    </dialog>
  )
}

function Overview() {
  const state = useDashboard()
  const connection = useConnection()
  const active = activeTasks(state)
  const questions = Object.values(state.questions).filter((q) => q.resolvedAt === null)
  const attention = tasksNeedingAttention(state)
  const all = Object.values(state.tasks)
  const completed = all.filter((task) => task.state === 'done')
  const prs = all.filter((task) => task.state === 'pr_open')
  const needsAttention = questions.length + attention.length
  return (
    <>
      <PageHeading
        eyebrow="THE BIG PICTURE"
        title="Your control room."
        description="Keep work moving. Give your attention where it matters."
      >
        <Link to="/issues" className="button primary">
          <Icon name="board" size={16} />
          Open task board
          <Icon name="arrow" size={16} />
        </Link>
      </PageHeading>
      <div className="overview-intro">
        <div>
          <span className="eyebrow">
            <span className={`connection-dot ${connection}`} /> ORCHESTRATION, IN VIEW
          </span>
          <h2>
            {needsAttention > 0
              ? 'A little direction goes a long way.'
              : active.length > 0
                ? 'Work is moving forward.'
                : 'Room for your next big idea.'}
          </h2>
          <p>
            {needsAttention > 0
              ? `${needsAttention} ${needsAttention === 1 ? 'item needs' : 'items need'} your attention. Answer questions and inspect blocked runs from your inbox.`
              : active.length > 0
                ? 'Follow your agents from first changes to pull request, all in one workspace.'
                : 'Your tasks, agents, and decisions come together here. Connected runs will appear automatically.'}
          </p>
          <Link to={needsAttention > 0 ? '/inbox' : '/runs'} className="text-link">
            {needsAttention > 0 ? 'Go to inbox' : 'Explore runs'}
            <Icon name="arrow" size={16} />
          </Link>
        </div>
        <div className="orbit-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit-core">
            <Icon name="agent" size={36} />
          </div>
          <span className="orbit-node node-one">
            <Icon name="check" />
          </span>
          <span className="orbit-node node-two">
            <Icon name="branch" />
          </span>
          <span className="orbit-node node-three">
            <Icon name="activity" />
          </span>
          <span className="orbit-caption">MANY AGENTS. ONE DIRECTION.</span>
        </div>
      </div>
      <div className="metrics">
        <Metric
          label="Active runs"
          value={active.length}
          detail="Work currently in flight"
          icon="runs"
          to="/runs"
        />
        <Metric
          label="Needs attention"
          value={needsAttention}
          detail={needsAttention ? 'Your input moves work forward' : 'Nothing waiting on you'}
          icon="inbox"
          to="/inbox"
          accent={needsAttention > 0}
        />
        <Metric
          label="Open pull requests"
          value={prs.length}
          detail="Ready for the next step"
          icon="branch"
          to="/runs"
        />
        <Metric
          label="Completed runs"
          value={completed.length}
          detail="Across this workspace"
          icon="check"
          to="/runs"
        />
      </div>
      <div className="overview-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <span className="live-dot" />
              In motion<span className="count-label">{active.length}</span>
            </h2>
            <Link to="/runs" className="text-link">
              All runs
              <Icon name="arrow" size={15} />
            </Link>
          </div>
          {active.length ? (
            <div className="run-stack">
              {active.slice(0, 5).map((task) => (
                <RunRow key={task.id} task={task} />
              ))}
            </div>
          ) : (
            <EmptyState title="A clear runway">
              No active runs yet. Browse the task board to see what's ready to work on.
            </EmptyState>
          )}
          <div className="panel-footnote">
            <Icon name="activity" size={14} />
            Updates stream in as your agents work.
          </div>
        </section>
        <section className="panel attention-panel">
          <div className="panel-heading">
            <h2>
              Your attention<span className="count-label">{needsAttention}</span>
            </h2>
            <Icon name="inbox" />
          </div>
          {needsAttention ? (
            <div className="attention-preview">
              {questions.slice(0, 2).map((q) => (
                <Link key={q.id} to="/inbox" className="attention-item">
                  <span className="eyebrow">AGENT QUESTION</span>
                  <h3>{q.question}</h3>
                  <p>{state.tasks[q.taskId]?.title ?? q.taskId}</p>
                  <span className="text-link">
                    Give direction
                    <Icon name="arrow" size={15} />
                  </span>
                </Link>
              ))}
              {attention.slice(0, 2).map((task) => (
                <Link
                  key={task.id}
                  to="/tasks/$id"
                  params={{ id: task.id }}
                  className="attention-item"
                >
                  <span className="eyebrow">NEEDS ATTENTION</span>
                  <h3>{task.title}</h3>
                  <p>{taskAttentionText(task)}</p>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState icon="check" title="You're all caught up">
              Questions and blocked runs will land here when your agents need you.
            </EmptyState>
          )}
        </section>
      </div>
      <section className="panel recent-activity">
        <div className="panel-heading">
          <h2>Latest activity</h2>
          <Link to="/activity" className="text-link">
            View timeline
            <Icon name="arrow" size={15} />
          </Link>
        </div>
        <ActivityList limit={5} />
      </section>
    </>
  )
}

function Metric({
  label,
  value,
  detail,
  icon,
  to,
  accent = false,
}: {
  label: string
  value: number
  detail: string
  icon: IconName
  to: '/runs' | '/inbox'
  accent?: boolean
}) {
  return (
    <Link to={to} className={`metric ${accent ? 'metric-attention' : ''}`}>
      <div className="metric-label">
        {label}
        <Icon name={icon} size={17} />
      </div>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <span>{detail}</span>
    </Link>
  )
}

function RunRow({ task }: { task: TaskView }) {
  const state = useDashboard()
  const agent = currentAgentFor(state, task.id)
  return (
    <Link to="/tasks/$id" params={{ id: task.id }} className="run-row">
      <span
        className={`run-avatar ${task.state === 'needs_human' || task.state === 'no_pr' ? 'attention-avatar' : ''}`}
      >
        <Icon name="agent" size={21} />
      </span>
      <span className="run-info">
        <strong>{task.title}</strong>
        <span className="run-meta">
          <span className="mono">{task.id}</span>
          <span>·</span>
          <span>{agent?.harness ?? task.tracker}</span>
          {agent?.model && (
            <>
              <span>·</span>
              <span>{agent.model}</span>
            </>
          )}
        </span>
      </span>
      <span className="run-status">
        <Badge state={task.state} />
        <Time ts={task.updatedAt} />
      </span>
      <span className="row-arrow">
        <Icon name="arrow" size={16} />
      </span>
    </Link>
  )
}

function RunsView() {
  const state = useDashboard()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const tasks = Object.values(state.tasks).sort((a, b) => b.updatedAt - a.updatedAt)
  const filters = [
    { id: 'all', label: 'All runs', match: (_task: TaskView) => true },
    { id: 'active', label: 'Active', match: (task: TaskView) => !isTerminal(task.state) },
    {
      id: 'attention',
      label: 'Needs attention',
      match: (task: TaskView) =>
        task.state === 'needs_human' || task.state === 'no_pr' || task.state === 'awaiting_answer',
    },
    { id: 'prs', label: 'Pull requests', match: (task: TaskView) => task.state === 'pr_open' },
    { id: 'completed', label: 'Completed', match: (task: TaskView) => task.state === 'done' },
  ]
  const selected = filters.find((item) => item.id === filter) ?? filters[0]
  const visible = tasks.filter(
    (task) =>
      selected?.match(task) &&
      `${task.id} ${task.title} ${task.branch ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <>
      <PageHeading
        eyebrow="AGENT OPERATIONS"
        title="Follow the work."
        description="Every run, from the first change to the final handoff."
      />
      <div className="toolbar">
        <fieldset className="filter-tabs" aria-label="Filter runs">
          {filters.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={filter === item.id}
              className={filter === item.id ? 'selected' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span>{tasks.filter(item.match).length}</span>
            </button>
          ))}
        </fieldset>
        <SearchField value={query} onChange={setQuery} placeholder="Search runs…" />
      </div>
      <section className="panel">
        {visible.length ? (
          visible.map((task) => <RunRow key={task.id} task={task} />)
        ) : (
          <EmptyState title={tasks.length ? 'No matching runs' : 'Your runs will appear here'}>
            {tasks.length
              ? 'Try another search or filter.'
              : 'Once an agent starts work, follow its progress, checks, and questions here.'}
          </EmptyState>
        )}
      </section>
    </>
  )
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
}
const issueStates = ['open', 'in_progress', 'blocked', 'closed'] as const
const issueLabels = {
  open: 'Ready to start',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Completed',
}

function IssuesView() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [selected, setSelected] = useState<Issue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [view, setView] = useState<'board' | 'list'>(() => {
    try {
      return localStorage.getItem('amagi:issue-view') === 'list' ? 'list' : 'board'
    } catch {
      return 'board'
    }
  })
  const state = useDashboard()
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh deliberately re-fetches the tracker snapshot.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`${apiBase}/api/issues`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok)
          throw new Error((await response.json()).error ?? `HTTP ${response.status}`)
        return response.json() as Promise<Issue[]>
      })
      .then((items) => {
        if (!controller.signal.aborted) setIssues(items)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [refresh])
  const changeView = (next: 'board' | 'list') => {
    setView(next)
    try {
      localStorage.setItem('amagi:issue-view', next)
    } catch {}
  }
  const visible = issues.filter(
    (issue) =>
      (status === 'all' || issue.status === status) &&
      `${issue.id} ${issue.title} ${issue.labels.join(' ')} ${issue.assignee ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  )
  if (selected)
    return (
      <>
        <button type="button" className="back-link" onClick={() => setSelected(null)}>
          ← Back to task board
        </button>
        <PageHeading
          eyebrow={selected.id}
          title={selected.title}
          description={selected.parent ? `Part of ${selected.parent}` : 'Task details'}
        >
          <IssueBadge issue={selected} />
        </PageHeading>
        <div className="detail-columns">
          <section className="panel prose-panel">
            <h2>Description</h2>
            <p className="preserve-whitespace">
              {selected.description || 'No description provided.'}
            </p>
            {selected.acceptanceCriteria && (
              <>
                <h2>Acceptance criteria</h2>
                <p className="preserve-whitespace">{selected.acceptanceCriteria}</p>
              </>
            )}
          </section>
          <section className="panel metadata-panel">
            <h2>Task context</h2>
            <dl>
              <DetailRow
                label="Priority"
                value={selected.priority === null ? 'Not set' : `P${selected.priority}`}
              />
              <DetailRow label="Type" value={selected.type} />
              <DetailRow label="Assignee" value={selected.assignee ?? 'Unassigned'} />
              <DetailRow label="Labels" value={selected.labels.join(', ') || null} />
            </dl>
            {state.tasks[selected.id] && (
              <Link className="button primary" to="/tasks/$id" params={{ id: selected.id }}>
                View agent run
                <Icon name="arrow" size={15} />
              </Link>
            )}
          </section>
        </div>
      </>
    )
  return (
    <>
      <PageHeading
        eyebrow="WORK, ORGANIZED"
        title="Make room for progress."
        description="The shared backlog. A clear path from idea to done."
      >
        <button
          type="button"
          className="button secondary"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <Icon name="refresh" size={16} />
          {loading ? 'Refreshing…' : 'Refresh tasks'}
        </button>
      </PageHeading>
      <div className="toolbar">
        <div className="task-tools">
          <SearchField
            value={query}
            onChange={setQuery}
            placeholder="Search tasks, labels, assignees…"
          />
          <select
            aria-label="Filter task status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All statuses</option>
            {issueStates.map((item) => (
              <option key={item} value={item}>
                {issueLabels[item]}
              </option>
            ))}
          </select>
        </div>
        <div className="view-tools">
          <span className="muted task-count">
            {visible.length} of {issues.length} tasks
          </span>
          <fieldset className="view-switch" aria-label="Task view">
            <button
              type="button"
              aria-label="Board view"
              aria-pressed={view === 'board'}
              onClick={() => changeView('board')}
            >
              <Icon name="board" size={16} />
            </button>
            <button
              type="button"
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => changeView('list')}
            >
              <Icon name="tasks" size={16} />
            </button>
          </fieldset>
        </div>
      </div>
      {error ? (
        <div className="error-banner" role="alert">
          <strong>Couldn't load tasks</strong>
          <p>{error}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="panel loading-state" role="status">
          Loading your task board…
        </div>
      ) : visible.length === 0 ? (
        <section className="panel">
          <EmptyState icon="board" title={issues.length ? 'No matching tasks' : 'A fresh start'}>
            {issues.length
              ? 'Try a different search or status.'
              : 'Tasks from your connected tracker will appear here.'}
          </EmptyState>
        </section>
      ) : view === 'board' ? (
        <div className="kanban">
          {issueStates
            .filter((item) => status === 'all' || status === item)
            .map((column) => {
              const items = visible.filter((issue) => issue.status === column)
              return (
                <section key={column} className="kanban-column">
                  <div className="kanban-heading">
                    <h2>
                      <span className={`issue-dot issue-${column}`} />
                      {issueLabels[column]}
                    </h2>
                    <span className="count-label">{items.length}</span>
                  </div>
                  <div className="kanban-cards">
                    {items.map((issue) => (
                      <button
                        key={issue.id}
                        type="button"
                        className="issue-card"
                        onClick={() => setSelected(issue)}
                      >
                        <span className="issue-card-top">
                          <span className="mono">{issue.id}</span>
                          {issue.priority !== null && (
                            <span className={`priority priority-${issue.priority}`}>
                              P{issue.priority}
                            </span>
                          )}
                        </span>
                        <strong>{issue.title}</strong>
                        {issue.labels.length > 0 && (
                          <span className="issue-tags">
                            {issue.labels.slice(0, 3).map((label) => (
                              <span key={label}>{label}</span>
                            ))}
                          </span>
                        )}
                        <span className="issue-card-footer">
                          <span>{issue.type ?? 'Task'}</span>
                          <span>{issue.assignee ?? 'Unassigned'}</span>
                        </span>
                      </button>
                    ))}
                    {items.length === 0 && <p className="column-empty">No tasks here yet</p>}
                  </div>
                </section>
              )
            })}
        </div>
      ) : (
        <section className="panel issue-list">
          {visible.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className="issue-list-row"
              onClick={() => setSelected(issue)}
            >
              <span className="mono">{issue.id}</span>
              <strong>{issue.title}</strong>
              <span className="muted">{issue.priority === null ? '' : `P${issue.priority}`}</span>
              <IssueBadge issue={issue} />
              <Icon name="arrow" size={16} />
            </button>
          ))}
        </section>
      )}
    </>
  )
}

function IssueBadge({ issue }: { issue: Issue }) {
  return (
    <span className={`badge issue-badge issue-${issue.status}`}>
      <span className="status-dot" />
      {issueLabels[issue.status]}
    </span>
  )
}

function InboxView() {
  const state = useDashboard()
  const questions = Object.values(state.questions)
    .filter((q) => q.resolvedAt === null)
    .sort((a, b) => a.askedAt - b.askedAt)
  const attention = tasksNeedingAttention(state)
  return (
    <>
      <PageHeading
        eyebrow="HUMAN IN THE LOOP"
        title="A moment of your attention."
        description="Give agents direction, unblock decisions, and keep the work moving."
      />
      <div className="inbox-summary">
        <span className="count-label">{questions.length}</span> open questions
        <span className="summary-divider" />
        <span className="count-label">{attention.length}</span> runs to inspect
      </div>
      {questions.length === 0 && attention.length === 0 ? (
        <section className="panel">
          <EmptyState icon="check" title="Nothing waiting on you">
            When an agent needs a decision or a run gets stuck, you'll see it here.
          </EmptyState>
        </section>
      ) : (
        <div className="inbox-grid">
          {questions.map((q) => (
            <QuestionCard key={q.id} question={q} />
          ))}
          {attention.map((task) => (
            <section key={task.id} className="panel blocked-card">
              <div className="panel-heading">
                <Badge state={task.state} />
                <Time ts={task.updatedAt} />
              </div>
              <div className="card-body">
                <h2>{task.title}</h2>
                <p>{taskAttentionText(task)}</p>
                <Link to="/tasks/$id" params={{ id: task.id }} className="button secondary">
                  Inspect run
                  <Icon name="arrow" size={16} />
                </Link>
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

function QuestionCard({ question }: { question: QuestionView }) {
  const state = useDashboard()
  return (
    <section className="panel question-card">
      <div className="panel-heading">
        <span className="question-label">
          <Icon name="inbox" size={16} />
          Agent needs direction
        </span>
        <Time ts={question.askedAt} />
      </div>
      <div className="card-body">
        <Link to="/tasks/$id" params={{ id: question.taskId }} className="question-task">
          {state.tasks[question.taskId]?.title ?? question.taskId}
          <Icon name="external" size={13} />
        </Link>
        <h2>{question.question}</h2>
        <AnswerBox taskId={question.taskId} question={question} />
      </div>
    </section>
  )
}

function AnswerBox({ taskId, question }: { taskId: string; question: QuestionView }) {
  const [token, setToken] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must request a fresh task token after a failed request.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetch(`${apiBase}/api/tasks/${encodeURIComponent(taskId)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not prepare the answer form.')
        const body = (await res.json()) as { token?: string }
        if (!body.token) throw new Error('No answer token is available for this run.')
        if (!controller.signal.aborted) setToken(body.token)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [taskId, attempt])
  const send = async (answer: string) => {
    if (!token || !answer.trim() || busy || sent) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/questions/${encodeURIComponent(question.id)}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Amagi-Token': token },
          body: JSON.stringify({ answer: answer.trim(), via: 'web' }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send(text)
  }
  if (sent)
    return (
      <p className="answer-success" role="status">
        <Icon name="check" size={16} />
        Answer sent. Waiting for the run to update.
      </p>
    )
  return (
    <div className="answer-box">
      {question.options.length > 0 && (
        <div className="answer-options">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              className="button secondary"
              disabled={!token || busy}
              onClick={() => void send(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <form onSubmit={submit}>
        <label htmlFor={`answer-${question.id}`} className="field-label">
          Your direction
        </label>
        <textarea
          id={`answer-${question.id}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Give context or write your own answer…"
          rows={3}
          disabled={busy}
        />
        <div className="answer-actions">
          <span className="muted">
            {loading ? 'Preparing answer form…' : 'Sent directly to this run.'}
          </span>
          <button
            type="submit"
            className="button primary"
            disabled={!token || busy || !text.trim()}
          >
            {busy ? 'Sending…' : 'Send answer'}
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
      {error && (
        <div className="answer-error" role="alert">
          {error}
          {!token && (
            <button
              type="button"
              className="text-link"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function eventDescription(event: StoredEvent): string {
  switch (event.type) {
    case 'task.claimed':
      return 'Run added to the queue'
    case 'task.reclaimed':
      return 'Run reclaimed'
    case 'task.state':
      return `Moved to ${stateLabels[event.to].toLowerCase()}${event.reason ? `: ${event.reason}` : ''}`
    case 'agent.started':
      return `${event.harness} started ${event.role === 'review' ? 'reviewing' : 'working'}${event.model ? ` with ${event.model}` : ''}`
    case 'agent.exited':
      return `Agent finished with exit code ${event.exitCode}`
    case 'checks.finished':
      return event.ok ? 'All checks passed' : 'Checks need another pass'
    case 'pr.created':
      return `Pull request #${event.number} opened`
    case 'commit.created':
      return event.subject
    case 'question.asked':
      return event.question
    case 'question.answered':
      return 'Human direction received'
    case 'question.timedout':
      return 'Question timed out'
    case 'question.parked':
      return 'Agent parked while waiting for an answer'
    case 'error':
      return event.message
    case 'retry.scheduled':
      return `Retry ${event.attempt} scheduled: ${event.reason}`
    case 'worktree.created':
      return 'Isolated workspace prepared'
    case 'worktree.removed':
      return 'Workspace cleaned up'
    case 'review.finished':
      return `Review finished with ${event.findings.length} findings`
    case 'notify.sent':
      return event.title
    case 'agent.stream':
      return 'Agent output'
  }
}

function ActivityList({
  limit = 100,
  query = '',
  taskId,
}: {
  limit?: number
  query?: string
  taskId?: string
}) {
  const state = useDashboard()
  const events = state.events
    .filter(
      (event) =>
        event.type !== 'agent.stream' &&
        (!taskId || event.taskId === taskId) &&
        `${eventDescription(event)} ${event.taskId ?? ''} ${event.taskId ? (state.tasks[event.taskId]?.title ?? '') : ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .slice(-limit)
    .reverse()
  if (!events.length)
    return (
      <EmptyState icon="activity" title={query ? 'No matching activity' : 'The story starts here'}>
        {query
          ? 'Try another search.'
          : 'Agent milestones, decisions, and results will appear as work happens.'}
      </EmptyState>
    )
  return (
    <ol className="activity-list">
      {events.map((event) => (
        <li key={event.seq}>
          <span className={`activity-icon ${event.type === 'error' ? 'activity-error' : ''}`}>
            <Icon
              name={
                event.type === 'question.asked'
                  ? 'inbox'
                  : event.type === 'pr.created'
                    ? 'branch'
                    : event.type === 'checks.finished'
                      ? 'check'
                      : 'activity'
              }
              size={15}
            />
          </span>
          <div>
            <p>{eventDescription(event)}</p>
            {event.taskId && (
              <Link to="/tasks/$id" params={{ id: event.taskId }}>
                {state.tasks[event.taskId]?.title ?? event.taskId}
              </Link>
            )}
          </div>
          <Time ts={event.ts} />
        </li>
      ))}
    </ol>
  )
}

function ActivityView() {
  const [query, setQuery] = useState('')
  return (
    <>
      <PageHeading
        eyebrow="THE WORKSPACE TIMELINE"
        title="Every step, in the open."
        description="Recent milestones, decisions, and handoffs across your agents."
      />
      <div className="toolbar">
        <span className="muted">Showing up to 100 recent events</span>
        <SearchField value={query} onChange={setQuery} placeholder="Search activity…" />
      </div>
      <section className="panel">
        <ActivityList query={query} />
      </section>
    </>
  )
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined) return null
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function PrLink({ url, number }: { url: string; number: number | null }) {
  let safe = false
  try {
    safe = ['https:', 'http:'].includes(new URL(url).protocol)
  } catch {}
  return safe ? (
    <a href={url} target="_blank" rel="noreferrer" className="text-link">
      <Icon name="branch" size={15} />
      {number ? `Pull request #${number}` : 'Open pull request'}
      <Icon name="external" size={14} />
    </a>
  ) : (
    <span>{url}</span>
  )
}

function TaskDetailView() {
  const { id } = useParams({ from: taskRoute.id })
  const state = useDashboard()
  const task = state.tasks[id]
  const questions = openQuestionsFor(state, id)
  const agent = currentAgentFor(state, id)
  const [tab, setTab] = useState<'output' | 'checks' | 'timeline'>('output')
  if (!task)
    return (
      <>
        <Link to="/runs" className="back-link">
          ← All runs
        </Link>
        <section className="panel">
          <EmptyState title="No run received yet">
            Waiting for events for {id}. Check the connection status if this run should already be
            available.
          </EmptyState>
        </section>
      </>
    )
  const phases = [
    { title: 'Prepare', states: ['claimed', 'worktree_ready'] },
    { title: 'Implement', states: ['implementing', 'awaiting_answer', 'retrying'] },
    { title: 'Check', states: ['checks', 'committed'] },
    { title: 'Review', states: ['pr_open', 'reviewing', 'fixing'] },
    { title: 'Complete', states: ['done'] },
  ]
  const phase = phases.findIndex((item) => item.states.includes(task.state))
  return (
    <>
      <Link to="/runs" className="back-link">
        ← All runs
      </Link>
      <PageHeading
        eyebrow={task.id}
        title={task.title}
        description={`Created ${new Date(task.createdAt).toLocaleString()}`}
      >
        <Badge state={task.state} />
        {task.prUrl && <PrLink url={task.prUrl} number={task.prNumber} />}
      </PageHeading>
      <ol className="run-pipeline" aria-label="Run progress">
        {phases.map((item, index) => (
          <li
            key={item.title}
            className={index === phase ? 'current' : index < phase ? 'passed' : ''}
            aria-current={index === phase ? 'step' : undefined}
          >
            <span>{index < phase ? <Icon name="check" size={14} /> : index + 1}</span>
            {item.title}
          </li>
        ))}
      </ol>
      {task.lastError && (
        <div className="error-banner">
          <strong>
            {task.state === 'needs_human'
              ? 'This run needs attention'
              : task.state === 'no_pr'
                ? 'No changes made — confirm before closing'
                : 'Last recorded error'}
          </strong>
          <p>{task.lastError}</p>
        </div>
      )}
      {questions.length > 0 && (
        <div className="detail-questions">
          {questions.map((question) => (
            <QuestionCard key={question.id} question={question} />
          ))}
        </div>
      )}
      <div className="detail-columns">
        <section className="panel run-output">
          <div className="filter-tabs detail-tabs">
            {(['output', 'checks', 'timeline'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={tab === item}
                className={tab === item ? 'selected' : ''}
                onClick={() => setTab(item)}
              >
                {item === 'output' ? 'Agent output' : item === 'checks' ? 'Checks' : 'Timeline'}
                {item === 'checks' && task.checks && <span>{task.checks.length}</span>}
              </button>
            ))}
          </div>
          {tab === 'output' && <AgentLogView taskId={id} />}
          {tab === 'timeline' && <ActivityList taskId={id} />}
          {tab === 'checks' &&
            (task.checks?.length ? (
              <div className="checks-list">
                {task.checks.map((check, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Commands may repeat within an immutable check result snapshot.
                  <details key={`${index}-${check.command}`} className="check-result">
                    <summary>
                      <span className={check.exitCode === 0 ? 'check-passed' : 'check-failed'}>
                        <Icon name={check.exitCode === 0 ? 'check' : 'close'} size={16} />
                        {check.exitCode === 0 ? 'Passed' : `Exit ${check.exitCode}`}
                      </span>
                      <code>{check.command}</code>
                    </summary>
                    <pre>{check.output || 'No output recorded.'}</pre>
                  </details>
                ))}
              </div>
            ) : (
              <EmptyState icon="check" title="No checks recorded yet">
                Check results will appear when the run validates its changes.
              </EmptyState>
            ))}
        </section>
        <aside className="panel metadata-panel">
          <h2>Run context</h2>
          <div className="agent-identity">
            <span className="run-avatar">
              <Icon name="agent" size={22} />
            </span>
            <div>
              <strong>{agent?.harness ?? 'Agent not started'}</strong>
              <span>{agent?.model ?? 'Model not reported'}</span>
            </div>
          </div>
          <dl>
            <DetailRow label="Role" value={agent?.role} />
            <DetailRow label="Effort" value={agent?.effort} />
            <DetailRow label="Tracker" value={task.tracker} />
            <DetailRow label="Review round" value={task.reviewRound} />
            <DetailRow label="Branch" value={task.branch} />
            <DetailRow label="Worktree" value={task.worktree} />
            <DetailRow
              label="Commit"
              value={
                task.lastCommit
                  ? `${task.lastCommit.sha.slice(0, 7)} · ${task.lastCommit.subject}`
                  : null
              }
            />
            <DetailRow label="Session" value={task.sessionId} />
            <DetailRow label="Updated" value={new Date(task.updatedAt).toLocaleString()} />
          </dl>
        </aside>
      </div>
    </>
  )
}

function SettingsView() {
  const [theme, setLocalTheme] = useState<Theme>(() => currentTheme())
  const changeTheme = (next: Theme) => {
    setLocalTheme(next)
    setTheme(next)
  }
  return (
    <>
      <PageHeading
        eyebrow="PREFERENCES"
        title="Make it yours."
        description="Client-side settings, saved in this browser."
      />
      <section className="panel settings-panel">
        <div className="panel-heading">
          <h2>
            <Icon name="settings" size={15} />
            Appearance
          </h2>
        </div>
        <div className="settings-row">
          <div>
            <h3>Theme</h3>
            <p>Choose light or dark. The first visit follows your operating system preference.</p>
          </div>
          <fieldset className="view-switch" aria-label="Theme">
            <button
              type="button"
              aria-pressed={theme === 'light'}
              onClick={() => changeTheme('light')}
            >
              <Icon name="sun" size={16} />
              Light
            </button>
            <button
              type="button"
              aria-pressed={theme === 'dark'}
              onClick={() => changeTheme('dark')}
            >
              <Icon name="moon" size={16} />
              Dark
            </button>
          </fieldset>
        </div>
      </section>
    </>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Overview })
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  component: RunsView,
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
  runsRoute,
  issuesRoute,
  inboxRoute,
  activityRoute,
  settingsRoute,
  taskRoute,
])
export const router = createRouter({ routeTree })
