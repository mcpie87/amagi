import { resolve, sep } from 'node:path'
import type { Notifier, RunServiceApi, WorkerActivity, Workspace, Workspaces } from '@amagi/core'
import { errMsg } from '@amagi/core'
import { createApp } from './app.ts'
import { type GatePoller, startGatePoller } from './gate-poller.ts'
import { type MentionWatcher, startMentionWatcher } from './mention-watcher.ts'
import { type PrConflictWatcher, startPrConflictWatcher } from './pr-conflict-watcher.ts'
import { type PrPoller, startPrPoller } from './pr-poller.ts'
import { type StallWatcher, startStallWatcher } from './stall-watcher.ts'

export type ServeOptions = {
  workspaces: Workspaces
  host: string
  port: number
  notify?: Notifier[] | undefined
  gatePollIntervalMs?: number
  prPollIntervalMs?: number
  mentionWatchIntervalMs?: number
  prConflictWatchIntervalMs?: number
  stallWatchIntervalMs?: number
  /** Directory holding the built dashboard, served as an SPA behind the API. */
  staticDir?: string
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi | undefined
  /** The repo key the runner is bound to; its settings apply live to it. */
  runnerRepo?: string | undefined
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
 * forge driver exists and a stall watcher (recovers tasks whose worker stopped
 * heartbeating). A supervisor checks the registry every few seconds so a repo
 * added (or removed) after startup gets (or loses) its pollers without
 * restarting the server.
 */
function startRepoPollers(
  workspaces: Workspaces,
  {
    gateIntervalMs,
    prIntervalMs,
    mentionIntervalMs,
    prConflictIntervalMs,
    stallIntervalMs,
  }: {
    gateIntervalMs?: number | undefined
    prIntervalMs?: number | undefined
    mentionIntervalMs?: number | undefined
    prConflictIntervalMs?: number | undefined
    stallIntervalMs?: number | undefined
  },
) {
  const pollers = new Map<
    string,
    {
      gate: GatePoller
      pr: PrPoller | null
      mention: MentionWatcher | null
      conflict: PrConflictWatcher | null
      stall: StallWatcher
    }
  >()

  function ensure(): void {
    const keys = new Set(workspaces.list().map((e) => e.key))
    for (const key of [...pollers.keys()]) {
      if (keys.has(key)) continue
      const p = pollers.get(key)
      p?.gate.stop()
      p?.pr?.stop()
      p?.mention?.stop()
      p?.conflict?.stop()
      p?.stall.stop()
      pollers.delete(key)
    }
    for (const key of keys) {
      if (pollers.has(key)) continue
      let ws: Workspace | null
      try {
        ws = workspaces.get(key)
      } catch (err) {
        console.warn(`repo ${key}: pollers skipped: ${errMsg(err)}`)
        continue
      }
      if (!ws) continue
      const forge = ws.forge
      pollers.set(key, {
        gate: startGatePoller({
          store: ws.store,
          tracker: ws.tracker,
          intervalMs: gateIntervalMs,
        }),
        pr:
          forge === null
            ? null
            : startPrPoller({
                store: ws.store,
                forge,
                tracker: ws.tracker,
                cwd: ws.root,
                intervalMs: prIntervalMs,
              }),
        mention:
          forge === null
            ? null
            : startMentionWatcher({
                repo: ws.key,
                root: ws.root,
                repoName: ws.name,
                config: ws.config,
                driver: forge,
                tracker: ws.tracker,
                intervalMs: mentionIntervalMs ?? ws.config.loop.mentionWatchIntervalSec * 1000,
              }),
        conflict:
          forge === null
            ? null
            : startPrConflictWatcher({
                repo: ws.key,
                root: ws.root,
                repoName: ws.name,
                config: ws.config,
                intervalMs: prConflictIntervalMs ?? ws.config.loop.prCheckIntervalSec * 1000,
              }),
        stall: startStallWatcher({
          repo: ws.key,
          store: ws.store,
          tracker: ws.tracker,
          timeoutMs: ws.config.loop.stallTimeoutSec * 1000,
          intervalMs: stallIntervalMs ?? ws.config.loop.stallWatchIntervalSec * 1000,
          ...(ws.config.loop.doomEnabled
            ? {
                doom: {
                  toolWindowMs: ws.config.loop.doomToolWindowSec * 1000,
                  toolRepeat: ws.config.loop.doomToolRepeat,
                  checkRounds: ws.config.loop.doomCheckRounds,
                  diffWindowMs: ws.config.loop.doomDiffWindowSec * 1000,
                },
              }
            : {}),
        }),
      })
    }
  }

  ensure()
  const supervisor = setInterval(ensure, 10_000)
  const workers = (): WorkerActivity[] =>
    [...pollers.values()].flatMap((p) => [
      ...(p.mention ? [p.mention.activity()] : []),
      ...(p.conflict ? [p.conflict.activity()] : []),
      p.stall.activity(),
    ])
  return {
    workers,
    stop() {
      clearInterval(supervisor)
      for (const p of pollers.values()) {
        p.gate.stop()
        p.pr?.stop()
        p.mention?.stop()
        p.conflict?.stop()
        p.stall.stop()
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
  prConflictWatchIntervalMs,
  stallWatchIntervalMs,
  staticDir,
  runner,
  runnerRepo,
}: ServeOptions) {
  const repoPollers = startRepoPollers(workspaces, {
    gateIntervalMs: gatePollIntervalMs,
    prIntervalMs: prPollIntervalMs,
    mentionIntervalMs: mentionWatchIntervalMs,
    prConflictIntervalMs: prConflictWatchIntervalMs,
    stallIntervalMs: stallWatchIntervalMs,
  })
  const app = createApp({
    workspaces,
    notify,
    runner,
    runnerRepo,
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
      runner?.dispose?.()
      return server.stop(closeActiveConnections)
    },
  }
}
