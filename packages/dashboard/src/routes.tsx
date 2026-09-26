import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootLayout } from './layout.tsx'
import { SessionsView } from './SessionsView.tsx'
import { ActivityView } from './views/activity.tsx'
import { QueueView } from './views/board.tsx'
import { InboxView } from './views/inbox.tsx'
import { IssuesView } from './views/issues.tsx'
import { OverviewView } from './views/overview.tsx'
import { SeatsView } from './views/seats.tsx'
import { SettingsView } from './views/settings.tsx'
import { TaskDetailView } from './views/task-detail.tsx'

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
export const issuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/issues',
  validateSearch: (search: Record<string, unknown>): { issue?: string; epic?: string } => ({
    ...(typeof search.issue === 'string' ? { issue: search.issue } : {}),
    ...(typeof search.epic === 'string' ? { epic: search.epic } : {}),
  }),
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

const routeTree = rootRoute.addChildren([
  indexRoute,
  boardRoute,
  issuesRoute,
  inboxRoute,
  activityRoute,
  sessionsRoute,
  settingsRoute,
  seatsRoute,
  taskRoute,
])
export const router = createRouter({ routeTree })
