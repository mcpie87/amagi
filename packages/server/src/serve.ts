import { resolve, sep } from 'node:path'
import type { BeadsIssue, PrDriver, RunServiceApi, Store, Tracker } from '@amagi/core'
import { createApp } from './app.ts'
import { startGatePoller } from './gate-poller.ts'
import { startPrPoller } from './pr-poller.ts'

export type ServeOptions = {
  store: Store
  host: string
  port: number
  tracker?: Tracker
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
  gatePollIntervalMs,
  forge,
  forgeCwd,
  prPollIntervalMs,
  staticDir,
  listIssues,
  runner,
  getIssue,
}: ServeOptions) {
  const app = createApp({
    store,
    ...(tracker === undefined ? {} : { tracker }),
    ...(listIssues === undefined ? {} : { listIssues }),
    ...(runner === undefined ? {} : { runner }),
    ...(getIssue === undefined ? {} : { getIssue }),
  })
  const poller =
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
      poller?.stop()
      prPoller?.stop()
      return server.stop(closeActiveConnections)
    },
  }
}
