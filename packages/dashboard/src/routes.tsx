import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { RootLayout } from './layout.tsx'
import { SessionsView } from './SessionsView.tsx'
import { ActivityView } from './views/activity.tsx'
import { ChatView } from './views/chat.tsx'
import { DiagnosticsView } from './views/diagnostics.tsx'
import { CommitDetailView, GitHistoryView } from './views/git.tsx'
import { InboxView } from './views/inbox.tsx'
import { ManualView } from './views/manual.tsx'
import { OverviewView } from './views/overview.tsx'
import { SeatsView } from './views/seats.tsx'
import { SettingsView } from './views/settings.tsx'
import { TaskDetailView } from './views/task-detail.tsx'
import { TasksView } from './views/tasks.tsx'

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewView,
})
export const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  validateSearch: (
    search: Record<string, unknown>,
  ): { triage?: string; repo?: string; chat?: string; thread?: string } => ({
    ...(typeof search.triage === 'string' ? { triage: search.triage } : {}),
    ...(typeof search.repo === 'string' ? { repo: search.repo } : {}),
    ...(typeof search.chat === 'string' ? { chat: search.chat } : {}),
    ...(typeof search.thread === 'string' ? { thread: search.thread } : {}),
  }),
  component: ChatView,
})
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/board',
  beforeLoad: () => {
    throw redirect({ to: '/tasks' })
  },
})
const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues',
  validateSearch: (search: Record<string, unknown>): { issue?: string } =>
    typeof search.issue === 'string' ? { issue: search.issue } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/tasks', search })
  },
})
export const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  validateSearch: (
    search: Record<string, unknown>,
  ): { issue?: string; repo?: string; epic?: string } => ({
    ...(typeof search.issue === 'string' ? { issue: search.issue } : {}),
    ...(typeof search.repo === 'string' ? { repo: search.repo } : {}),
    ...(typeof search.epic === 'string' ? { epic: search.epic } : {}),
  }),
  component: TasksView,
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
const diagnosticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/diagnostics',
  component: DiagnosticsView,
})
const settingsTabs = [
  'general',
  'configuration',
  'appearance',
  'profiles',
  'workers',
  'repositories',
  'credentials',
] as const
type SettingsTab = (typeof settingsTabs)[number]

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  validateSearch: (
    search: Record<string, unknown>,
  ): { repo?: string; tab?: SettingsTab; add?: boolean } => ({
    ...(search.add === true ? { add: true } : {}),
    ...(typeof search.repo === 'string' ? { repo: search.repo } : {}),
    ...(typeof search.tab === 'string' && settingsTabs.includes(search.tab as SettingsTab)
      ? { tab: search.tab as SettingsTab }
      : {}),
  }),
  component: SettingsView,
})
export const manualRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/manual',
  validateSearch: (search: Record<string, unknown>): { page?: string } =>
    typeof search.page === 'string' ? { page: search.page } : {},
  component: ManualView,
})
const seatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/seats',
  component: SeatsView,
})
export const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$id',
  component: TaskDetailView,
})
export const gitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/git',
  component: GitHistoryView,
})
export const gitCommitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/git/commits/$hash',
  component: CommitDetailView,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  boardRoute,
  issuesRoute,
  tasksRoute,
  inboxRoute,
  activityRoute,
  sessionsRoute,
  settingsRoute,
  diagnosticsRoute,
  seatsRoute,
  manualRoute,
  taskRoute,
  gitRoute,
  gitCommitRoute,
])
export const router = createRouter({ routeTree })
