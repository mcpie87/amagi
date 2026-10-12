import { tasksNeedingAttention } from '@amagi/core/view'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { ChevronRight, FolderGit2, Moon, Sun } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import logo from './assets/logo.png'
import { Button } from './components/ui/button.tsx'
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar.tsx'
import {
  type RepoInfo,
  RunnerProvider,
  repoBlockers,
  useConnection,
  useDashboard,
  useRunner,
} from './store.tsx'
import { setThemePref, useTheme } from './theme.ts'
import { Icon, type IconName } from './ui.tsx'

function WorkspaceStatus() {
  const connection = useConnection()
  const { status } = useRunner()
  const connectionLabel =
    connection === 'connected'
      ? 'Live updates'
      : connection === 'reconnecting'
        ? 'Reconnecting'
        : 'Connecting'
  const shortConnectionLabel = connection === 'connected' ? 'Live' : connectionLabel
  const tone =
    connection === 'connected'
      ? 'bg-emerald-ink'
      : connection === 'reconnecting'
        ? 'bg-amber-ink'
        : 'bg-fg-faint'
  const seatSummary =
    status === null ? 'Runner unknown' : `${status.busySeats}/${status.totalSeats} seats`

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={`${connectionLabel}; ${seatSummary}. Show status details.`}
          className="flex h-7 w-full items-center gap-2 rounded-full border border-sidebar-border bg-sidebar-accent/50 px-2.5 text-left text-[10px] font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2"
        >
          <span className={`connection-dot size-2 shrink-0 ${tone}`} />
          <span className="group-data-[collapsible=icon]:hidden">{shortConnectionLabel}</span>
          <span
            aria-hidden="true"
            className="text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden"
          >
            ·
          </span>
          <span className="min-w-0 truncate group-data-[collapsible=icon]:hidden">
            {seatSummary}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-3 shrink-0 text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden"
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="start"
          sideOffset={8}
          className="z-50 w-72 space-y-3 rounded-lg border border-line bg-surface p-3 text-xs text-fg shadow-xl"
        >
          <div className="flex items-center gap-2">
            <span className={`connection-dot size-2 shrink-0 ${tone}`} />
            <div>
              <p className="font-medium">{connectionLabel}</p>
              <p className="text-fg-muted">Connection to the amagi server</p>
            </div>
          </div>
          {status === null ? (
            <p className="border-t border-line pt-2 text-fg-muted">Runner status unavailable.</p>
          ) : (
            <div className="space-y-2 border-t border-line pt-2">
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Runner</span>
                <span className="truncate font-medium">{status.name}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Seats</span>
                <span className="font-medium">
                  {status.busySeats}/{status.totalSeats} busy ·{' '}
                  {status.available ? 'available' : 'busy'}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-fg-muted">Auto queue</span>
                <span className="font-medium">{status.autoQueue ? 'On' : 'Off'}</span>
              </div>
              <div>
                <p className="mb-1 text-fg-muted">Running work</p>
                {status.running.length === 0 ? (
                  <p className="text-fg-muted">No active runs.</p>
                ) : (
                  <ul className="space-y-1">
                    {status.running.map((taskId) => {
                      const task = status.tasks[taskId]
                      return (
                        <li key={taskId} className="min-w-0">
                          <p className="truncate font-medium">{task?.title ?? taskId}</p>
                          <p className="truncate text-fg-muted">
                            {taskId}
                            {task?.workerName ? ` · ${task.workerName}` : ''}
                          </p>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

/**
 * The search workspace command palette: a native dialog listing tasks and
 * pages matching the query. Escape, a backdrop click or the input losing focus
 * closes it; Enter or a click jumps to the highlighted entry.
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
      const dialog = dialogRef.current
      if (
        dialog?.open &&
        (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape')
      ) {
        event.preventDefault()
        event.stopPropagation()
        dialog.close()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        open()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
    { to: '/chat', label: 'Chat' },
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
        aria-label="Search"
        title="Search"
        onClick={open}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2 text-sm text-fg-muted hover:border-line-strong hover:text-fg group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-2"
      >
        <Icon name="search" size={15} />
        <span className="group-data-[collapsible=icon]:hidden">Search</span>
        <kbd className="ml-auto rounded border border-line-strong px-1 font-mono text-[10px] group-data-[collapsible=icon]:hidden">
          ⌘K
        </kbd>
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: The window key handler dismisses the dialog. */}
      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === dialogRef.current) close()
        }}
        onMouseDown={(event) => {
          // Keeps focus in the input so clicks inside do not trip its blur close.
          if (event.target !== inputRef.current) event.preventDefault()
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
            onBlur={(event) => {
              // Vimium-style extensions swallow Escape in an input and only blur it.
              const target = event.relatedTarget
              const inside = target instanceof Node && dialogRef.current?.contains(target)
              if (!inside && document.hasFocus()) close()
            }}
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
  return repoBlockers(repo).length === 0
}

/**
 * What needs the operator right now: every blocked repo, plus the selected
 * repo's open questions and stuck tasks (only that repo's stream is loaded).
 */
function useAttentionCount(): number {
  const { repos, state } = useDashboard()
  const blocked = (repos ?? []).filter((repo) => !readyOk(repo)).length
  const questions = Object.values(state.questions).filter((q) => q.resolvedAt === null).length
  return blocked + questions + tasksNeedingAttention(state).length
}

function BlockedBanner() {
  const { repos, selected } = useDashboard()
  const repo = repos?.find((r) => r.key === selected)
  if (repo === undefined) return null
  const blockers = repoBlockers(repo)
  if (blockers.length === 0) return null
  return (
    <div role="alert" className="border-b border-red-edge bg-red-soft px-4 py-3 sm:px-6">
      <div className="mx-auto max-w-6xl text-sm text-red-ink">
        <p className="font-semibold">{repo.name} is blocked and will not run work.</p>
        <ul className="mt-1 space-y-0.5">
          {blockers.map((check) => (
            <li key={check.name}>
              {check.name}
              {check.detail ? `: ${check.detail}` : ''}
            </li>
          ))}
        </ul>
        <Link to="/settings" className="mt-1 inline-block underline">
          Open settings
        </Link>
      </div>
    </div>
  )
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
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-solid hover:bg-accent/90 disabled:opacity-50"
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
  to:
    | '/'
    | '/chat'
    | '/board'
    | '/issues'
    | '/inbox'
    | '/activity'
    | '/git'
    | '/sessions'
    | '/seats'
    | '/settings'
    | '/diagnostics'
    | '/manual'
  label: string
  icon: IconName
}[] = [
  { to: '/', label: 'Overview', icon: 'overview' },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/board', label: 'Board', icon: 'board' },
  { to: '/issues', label: 'Tasks', icon: 'tasks' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/git', label: 'Git history', icon: 'activity' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions' },
  { to: '/seats', label: 'Seats', icon: 'agent' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/diagnostics', label: 'Diagnostics', icon: 'gauge' },
  { to: '/manual', label: 'Manual', icon: 'book' },
]

function ThemeToggle() {
  const theme = useTheme()
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${nextTheme} theme`

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => setThemePref(nextTheme)}
      className="size-8 shrink-0 group-data-[collapsible=icon]:hidden"
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  )
}

function AppSidebar() {
  const { repos, selected, selectRepo } = useDashboard()
  const selectedRepo = repos?.find((repo) => repo.key === selected)
  const attention = useAttentionCount()
  const [adding, setAdding] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { isMobile, setOpenMobile } = useSidebar()
  const onNavigate = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader className="px-2 py-2">
        <div className="flex h-10 items-center gap-1.5">
          <SidebarTrigger
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            className="size-8 shrink-0"
          />
          <Link
            to="/"
            onClick={onNavigate}
            className="flex h-full min-w-0 flex-1 items-center justify-center group-data-[collapsible=icon]:hidden"
          >
            <img src={logo} alt="amagi" className="block h-7 w-auto" />
          </Link>
          <ThemeToggle />
        </div>
        <CommandPalette />
        <WorkspaceStatus />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-2 py-0">
          <SidebarMenu>
            {NAV_ITEMS.map((item) => (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton asChild isActive={pathname === item.to} tooltip={item.label}>
                  <Link to={item.to} onClick={onNavigate}>
                    <Icon name={item.icon} size={17} />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
                {item.to === '/inbox' && attention > 0 && (
                  <SidebarMenuBadge
                    role="status"
                    aria-label={`${attention} items need attention`}
                    className="rounded-full bg-red-ink text-surface"
                  >
                    {attention}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-2">
        {repos !== null && repos.length > 0 && (
          <div className="relative mb-2 group-data-[collapsible=icon]:mb-0">
            <label
              htmlFor="repo-select"
              className="mb-1 block text-[10px] uppercase tracking-wider text-fg-faint group-data-[collapsible=icon]:hidden"
            >
              Repository
            </label>
            <FolderGit2
              aria-hidden="true"
              className="hidden size-8 p-2 text-sidebar-foreground group-data-[collapsible=icon]:block"
            />
            <select
              id="repo-select"
              aria-label="Repository"
              title={`Repository: ${selectedRepo?.name ?? 'select one'}`}
              value={selected ?? ''}
              onChange={(e) => selectRepo(e.target.value)}
              className="w-full rounded border border-line-strong bg-surface px-2 py-1 text-sm group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:inset-0 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:cursor-pointer group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:focus-visible:ring-2"
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
        <div className="group-data-[collapsible=icon]:hidden">
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
      </SidebarFooter>
      <SidebarRail />
    </ShadcnSidebar>
  )
}

export function RootLayout() {
  const { repos } = useDashboard()
  const attention = useAttentionCount()
  // Chat renders a full-bleed sidebar that must sit flush against the nav, so it drops the column cap.
  const fullBleed = useRouterState({ select: (state) => state.location.pathname === '/chat' })
  const [idleNotice, setIdleNotice] = useState<{ title: string; body: string } | null>(null)
  const [desktopFailure, setDesktopFailure] = useState<{ title: string; body: string } | null>(null)

  useEffect(() => {
    document.title =
      attention > 0 ? `(${attention}) amagi · Agent workspace` : 'amagi · Agent workspace'
  }, [attention])

  useEffect(() => {
    const onIdleNotification = (event: Event) => {
      const detail = (event as CustomEvent<{ title: string; body: string }>).detail
      setIdleNotice(detail)
      window.setTimeout(() => setIdleNotice(null), 8000)
    }
    window.addEventListener('amagi:idle-notification', onIdleNotification)
    return () => window.removeEventListener('amagi:idle-notification', onIdleNotification)
  }, [])

  useEffect(() => {
    const onDesktopFailure = (event: Event) => {
      const detail = (event as CustomEvent<{ title: string; body: string }>).detail
      setDesktopFailure(detail)
    }
    window.addEventListener('amagi:desktop-notification-failure', onDesktopFailure)
    return () => window.removeEventListener('amagi:desktop-notification-failure', onDesktopFailure)
  }, [])

  return (
    <RunnerProvider>
      <SidebarProvider className="app-shell">
        {idleNotice !== null && (
          <div
            role="status"
            className="fixed bottom-4 right-4 z-50 max-w-sm rounded border border-line-strong bg-surface px-4 py-3 shadow-lg"
          >
            <p className="font-semibold">{idleNotice.title}</p>
            <p className="mt-1 text-sm text-fg-muted">{idleNotice.body}</p>
            <button
              type="button"
              className="mt-2 text-xs text-fg-faint hover:text-fg"
              onClick={() => setIdleNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        {desktopFailure !== null && (
          <div
            role="alert"
            className="fixed bottom-4 left-4 z-50 max-w-sm rounded border border-red-ink bg-surface px-4 py-3 shadow-lg"
          >
            <p className="font-semibold">Desktop notification failed: {desktopFailure.title}</p>
            <p className="mt-1 text-sm text-fg-muted">{desktopFailure.body}</p>
            <button
              type="button"
              className="mt-2 text-xs text-fg-faint hover:text-fg"
              onClick={() => setDesktopFailure(null)}
            >
              Dismiss
            </button>
          </div>
        )}
        <AppSidebar />
        <div className="workspace">
          <SidebarTrigger
            aria-label="Open navigation"
            title="Open navigation"
            className={`mobile-menu-button fixed top-3 z-40 ${fullBleed ? 'left-14' : 'left-3'}`}
          />
          <BlockedBanner />
          <main
            className={`mx-auto w-full flex-1 px-4 py-6 sm:px-6${fullBleed ? '' : ' pt-16 md:pt-6 max-w-6xl'}`}
          >
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
      </SidebarProvider>
    </RunnerProvider>
  )
}
