import { resolve, sep } from 'node:path'
import type { Notifier, RunServiceApi, Workspace, Workspaces } from '@amagi/core'
import { createApp } from './app.ts'
import { type GatePoller, startGatePoller } from './gate-poller.ts'
import { type PrPoller, startPrPoller } from './pr-poller.ts'

export type ServeOptions = {
  workspaces: Workspaces
  host: string
  port: number
  notify?: Notifier[]
  gatePollIntervalMs?: number
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

/**
 * Gate and PR pollers are per repo. A supervisor checks the registry every few
 * seconds so a repo added (or removed) after startup gets (or loses) its
 * pollers without restarting the server.
 */
function startRepoPollers(
  workspaces: Workspaces,
  { gateIntervalMs, prIntervalMs }: { gateIntervalMs?: number; prIntervalMs?: number },
) {
  const pollers = new Map<string, { gate: GatePoller; pr: PrPoller | null }>()

  function ensure(): void {
    const keys = new Set(workspaces.list().map((e) => e.key))
    for (const key of [...pollers.keys()]) {
      if (keys.has(key)) continue
      const p = pollers.get(key)
      p?.gate.stop()
      p?.pr?.stop()
      pollers.delete(key)
    }
    for (const key of keys) {
      if (pollers.has(key)) continue
      let ws: Workspace | null
      try {
        ws = workspaces.get(key)
      } catch (err) {
        console.warn(
          `repo ${key}: pollers skipped: ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }
      if (!ws) continue
      pollers.set(key, {
        gate: startGatePoller({
          store: ws.store,
          tracker: ws.tracker,
          ...(gateIntervalMs === undefined ? {} : { intervalMs: gateIntervalMs }),
        }),
        pr:
          ws.forge === null
            ? null
            : startPrPoller({
                store: ws.store,
                forge: ws.forge,
                cwd: ws.root,
                ...(prIntervalMs === undefined ? {} : { intervalMs: prIntervalMs }),
              }),
      })
    }
  }

  ensure()
  const supervisor = setInterval(ensure, 10_000)
  return {
    stop() {
      clearInterval(supervisor)
      for (const p of pollers.values()) {
        p.gate.stop()
        p.pr?.stop()
      }
      pollers.clear()
    },
  }
}

export function serve({
  workspaces,
  host,
  port,
  notify,
  gatePollIntervalMs,
  prPollIntervalMs,
  staticDir,
  runner,
}: ServeOptions) {
  const app = createApp({
    workspaces,
    ...(notify === undefined ? {} : { notify }),
    ...(runner === undefined ? {} : { runner }),
  })
  const repoPollers = startRepoPollers(workspaces, {
    ...(gatePollIntervalMs === undefined ? {} : { gateIntervalMs: gatePollIntervalMs }),
    ...(prPollIntervalMs === undefined ? {} : { prIntervalMs: prPollIntervalMs }),
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
      repoPollers.stop()
      return server.stop(closeActiveConnections)
    },
  }
}
