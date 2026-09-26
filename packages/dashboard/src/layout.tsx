import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { type RepoInfo, RunnerProvider, useConnection, useDashboard, useRunner } from './store.tsx'
import { Icon, type IconName } from './ui.tsx'

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
      runner: {status.busySeats}/{status.totalSeats} seats · {status.available ? 'free' : 'busy'}
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

  const open = useCallback(() => {
    setQuery('')
    setIndex(0)
    dialogRef.current?.showModal()
    inputRef.current?.focus()
  }, [])
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
  }, [open])

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
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape handles keyboard dismissal for the native dialog. */}
      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === dialogRef.current) close()
        }}
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
  to: '/' | '/board' | '/issues' | '/inbox' | '/activity' | '/sessions' | '/seats' | '/settings'
  label: string
  icon: IconName
}[] = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/issues', label: 'Tasks', icon: 'tasks' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/seats', label: 'Seats', icon: 'agent' },
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

export function RootLayout() {
  const { repos } = useDashboard()
  const [navOpen, setNavOpen] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const firstRender = useRef(true)

  const openNav = () => setNavOpen(true)
  const closeNav = useCallback(() => setNavOpen(false), [])

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
  }, [navOpen, closeNav])

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
