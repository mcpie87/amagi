import { resolve, sep } from 'node:path'
import type { Notifier, RunServiceApi, WorkerActivity, Workspace, Workspaces } from '@amagi/core'
import { createApp } from './app.ts'
import { type GatePoller, startGatePoller } from './gate-poller.ts'
import { type MentionWatcher, startMentionWatcher } from './mention-watcher.ts'
import { type PrPoller, startPrPoller } from './pr-poller.ts'

export type ServeOptions = {
  workspaces: Workspaces
  host: string
  port: number
  notify?: Notifier[]
  gatePollIntervalMs?: number
  prPollIntervalMs?: number
  mentionWatchIntervalMs?: number
  /** Directory holding the built dashboard, served as an SPA behind the API. */
  staticDir?: string
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi
  /** The repo key the runner is bound to; its settings apply live to it. */
  runnerRepo?: string
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
 * Gate and PR pollers are per repo, plus an agent-mention watcher wherever a
 * forge driver exists. A supervisor checks the registry every few seconds so
 * a repo added (or removed) after startup gets (or loses) its pollers without
 * restarting the server.
 */
function startRepoPollers(
  workspaces: Workspaces,
  {
    gateIntervalMs,
    prIntervalMs,
    mentionIntervalMs,
  }: {
    gateIntervalMs?: number
    prIntervalMs?: number
    mentionIntervalMs?: number
  },
) {
  const pollers = new Map<
    string,
    { gate: GatePoller; pr: PrPoller | null; mention: MentionWatcher | null }
  >()

  function ensure(): void {
    const keys = new Set(workspaces.list().map((e) => e.key))
    for (const key of [...pollers.keys()]) {
      if (keys.has(key)) continue
      const p = pollers.get(key)
      p?.gate.stop()
      p?.pr?.stop()
      p?.mention?.stop()
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
      const forge = ws.forge
      if (forge === null) {
        pollers.set(key, {
          gate: startGatePoller({
            store: ws.store,
            tracker: ws.tracker,
            ...(gateIntervalMs === undefined ? {} : { intervalMs: gateIntervalMs }),
          }),
          pr: null,
          mention: null,
        })
        continue
      }
      pollers.set(key, {
        gate: startGatePoller({
          store: ws.store,
          tracker: ws.tracker,
          ...(gateIntervalMs === undefined ? {} : { intervalMs: gateIntervalMs }),
        }),
        pr: startPrPoller({
          store: ws.store,
          forge,
          tracker: ws.tracker,
          cwd: ws.root,
          ...(prIntervalMs === undefined ? {} : { intervalMs: prIntervalMs }),
        }),
        mention: startMentionWatcher({
          repo: ws.key,
          root: ws.root,
          repoName: ws.name,
          config: ws.config,
          driver: forge,
          tracker: ws.tracker,
          intervalMs: mentionIntervalMs ?? ws.config.loop.mentionWatchIntervalSec * 1000,
        }),
      })
    }
  }

  ensure()
  const supervisor = setInterval(ensure, 10_000)
  const workers = (): WorkerActivity[] =>
    [...pollers.values()].flatMap((p) => (p.mention ? [p.mention.activity()] : []))
  return {
    workers,
    stop() {
      clearInterval(supervisor)
      for (const p of pollers.values()) {
        p.gate.stop()
        p.pr?.stop()
        p.mention?.stop()
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
  mentionWatchIntervalMs,
  staticDir,
  runner,
  runnerRepo,
}: ServeOptions) {
  const repoPollers = startRepoPollers(workspaces, {
    ...(gatePollIntervalMs === undefined ? {} : { gateIntervalMs: gatePollIntervalMs }),
    ...(prPollIntervalMs === undefined ? {} : { prIntervalMs: prPollIntervalMs }),
    ...(mentionWatchIntervalMs === undefined ? {} : { mentionIntervalMs: mentionWatchIntervalMs }),
  })
  const app = createApp({
    workspaces,
    ...(notify === undefined ? {} : { notify }),
    ...(runner === undefined ? {} : { runner }),
    ...(runnerRepo === undefined ? {} : { runnerRepo }),
    workers: repoPollers.workers,
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
