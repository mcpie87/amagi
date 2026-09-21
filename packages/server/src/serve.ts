import { resolve, sep } from 'node:path'
import type {
  BeadsIssue,
  Config,
  PrDriver,
  RunServiceApi,
  Store,
  Tracker,
  WorkerActivity,
} from '@amagi/core'
import { createApp } from './app.ts'
import { startGatePoller } from './gate-poller.ts'
import { startMentionWatcher } from './mention-watcher.ts'
import { startPrPoller } from './pr-poller.ts'
import { startStallWatcher } from './stall-watcher.ts'

export type ServeOptions = {
  store: Store
  host: string
  port: number
  tracker?: Tracker
  /** Repo identity the mention watcher needs; without it the watcher is skipped. */
  repoName?: string
  repoRoot?: string
  /** Cadence for the mention/stall watchers comes from the loop section. */
  config?: Config
  listIssues?: () => Promise<BeadsIssue[]>
  getIssue?: (id: string) => Promise<BeadsIssue | null>
  gatePollIntervalMs?: number
  /**
   * When present, park tasks at pr_open are reconciled against the remote PR
   * state, settling merged and closed PRs. `forgeCwd` is the repo the PRs live
   * in, so the forge CLI can resolve them.
   */
  forge?: PrDriver
  forgeCwd?: string
  prPollIntervalMs?: number
  mentionWatchIntervalMs?: number
  stallWatchIntervalMs?: number
  /** Directory holding the built dashboard, served as an SPA behind the API. */
  staticDir?: string
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi
}

/**
 * Serves one built asset, falling back to index.html so router paths like
 * /tasks/:id deep-link. Traversal is refused: a served path must stay inside
 * staticDir, which matters once host is anything other than loopback.
 */
async function staticAsset(dir: string, pathname: string): Promise<Response> {
  const root = resolve(dir)
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const target = resolve(root, rel)
  if (!target.startsWith(root + sep)) {
    return new Response('not found', { status: 404 })
  }
  const file = Bun.file(target)
  if (await file.exists()) return new Response(file)
  const index = Bun.file(resolve(root, 'index.html'))
  if (await index.exists()) return new Response(index)
  return new Response('dashboard not built', { status: 404 })
}

export function serve({
  store,
  host,
  port,
  tracker,
  repoName,
  repoRoot,
  config,
  listIssues,
  gatePollIntervalMs,
  forge,
  forgeCwd,
  prPollIntervalMs,
  mentionWatchIntervalMs,
  stallWatchIntervalMs,
  staticDir,
  runner,
  getIssue,
}: ServeOptions) {
  const gatePoller =
    tracker === undefined
      ? null
      : startGatePoller({
          store,
          tracker,
          ...(gatePollIntervalMs === undefined ? {} : { intervalMs: gatePollIntervalMs }),
        })
  const prPoller =
    forge === undefined || forgeCwd === undefined || tracker === undefined
      ? null
      : startPrPoller({
          store,
          forge,
          tracker,
          cwd: forgeCwd,
          ...(prPollIntervalMs === undefined ? {} : { intervalMs: prPollIntervalMs }),
        })
  // Background workers: a mention watcher wherever a forge driver exists and a
  // stall watcher that recovers tasks whose worker stopped heartbeating. Their
  // activity is surfaced through /api/runner, like main's orchestration panel.
  const mentionPoller =
    config === undefined ||
    repoName === undefined ||
    repoRoot === undefined ||
    forge === undefined ||
    tracker === undefined
      ? null
      : startMentionWatcher({
          repo: repoName,
          root: repoRoot,
          repoName,
          config,
          driver: forge,
          tracker,
          intervalMs: mentionWatchIntervalMs ?? config.loop.mentionWatchIntervalSec * 1000,
        })
  const stallPoller =
    tracker === undefined
      ? null
      : startStallWatcher({
          repo: repoName ?? 'repo',
          store,
          tracker,
          timeoutMs: (config?.loop.stallTimeoutSec ?? 3600) * 1000,
          intervalMs: stallWatchIntervalMs ?? (config?.loop.stallWatchIntervalSec ?? 300) * 1000,
        })
  const workers = (): WorkerActivity[] => [
    ...(mentionPoller === null ? [] : [mentionPoller.activity()]),
    ...(stallPoller === null ? [] : [stallPoller.activity()]),
  ]
  const app = createApp({
    store,
    ...(tracker === undefined ? {} : { tracker }),
    ...(listIssues === undefined ? {} : { listIssues }),
    ...(runner === undefined ? {} : { runner }),
    ...(getIssue === undefined ? {} : { getIssue }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(config === undefined ? {} : { config }),
    workers,
  })
  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      if (staticDir !== undefined && !new URL(req.url).pathname.startsWith('/api')) {
        return staticAsset(staticDir, new URL(req.url).pathname)
      }
      return app.fetch(req)
    },
  })
  return {
    hostname: server.hostname,
    port: server.port,
    url: server.url,
    stop(closeActiveConnections?: boolean): Promise<void> {
      gatePoller?.stop()
      prPoller?.stop()
      mentionPoller?.stop()
      stallPoller?.stop()
      return server.stop(closeActiveConnections)
    },
  }
}
