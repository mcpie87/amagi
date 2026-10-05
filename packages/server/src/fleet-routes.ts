import {
  addForgeCredential,
  Config,
  errMsg,
  ForgeKind,
  forgeTokenStates,
  type GitIdentity,
  hasPinnedForgeRemote,
  hasStaleMaxParallel,
  LibnotifyNotifier,
  listForgeCredentials,
  loadConfig,
  loadGlobalConfig,
  NtfyNotifier,
  newWorkerId,
  pickForgeCredential,
  type RunServiceApi,
  removeForgeCredential,
  updateForgeCredential,
  WorkerConfig,
  type Workspaces,
  writeConfig,
  writeGlobalConfig,
} from '@amagi/core'
import { Hono } from 'hono'
import * as z from 'zod'
import { resolveWorkspace, valid } from './route-utils.ts'
import {
  ForgeCredentialCreateBody,
  ForgeCredentialParam,
  ForgeCredentialUpdateBody,
  GitIdentityBody,
  ParticipationBody,
  RepoParam,
  SettingsBody,
  TaskIdParam,
  WatcherParam,
  WatcherUpdateBody,
  WorkerCreateBody,
  WorkerUpdateBody,
} from './schemas.ts'

function gitRemotes(root: string): string[] {
  try {
    const result = Bun.spawnSync(['git', 'remote'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
    return result.exitCode === 0 ? result.stdout.toString().split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

export type FleetRouteDeps = {
  workspaces: Workspaces
  runnerFor: (repo: string) => RunServiceApi | undefined
  saveFleet: (fleet: WorkerConfig[]) => void
  fleetView: () => Promise<(WorkerConfig & { taskId: string | null })[]>
  validateGitIdentity: (identity: GitIdentity | null) => GitIdentity | null
}

export function createFleetRoutes({
  workspaces,
  runnerFor,
  saveFleet,
  fleetView,
  validateGitIdentity,
}: FleetRouteDeps) {
  return new Hono()
    .get('/api/repos/:repo/settings', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      return c.json({
        autoQueue: ws.config.loop.autoQueue,
        ntfyTopic: ws.config.notify.ntfyTopic,
        ntfyServer: ws.config.notify.ntfyServer,
        desktopFailureAlerts: ws.config.notify.desktopFailureAlerts,
        reviewMaxRounds: ws.config.review.maxRounds,
        staleMaxParallel: hasStaleMaxParallel(ws.root),
        forgeKind: ws.config.forge.kind,
        forgeRemote: ws.config.forge.remote,
        forgeRemotePinned: hasPinnedForgeRemote(ws.root),
        remotes: gitRemotes(ws.root),
        forgeCredentials: forgeTokenStates(ws.root),
      })
    })

    .patch(
      '/api/repos/:repo/settings',
      valid('param', RepoParam),
      valid('json', SettingsBody),
      (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const {
          autoQueue,
          ntfyTopic,
          ntfyServer,
          desktopFailureAlerts,
          reviewMaxRounds,
          forgeKind,
          forgeRemote,
          forgeCredentials,
        } = c.req.valid('json')
        const remotes = gitRemotes(ws.root)
        if (forgeRemote != null && !remotes.includes(forgeRemote)) {
          return c.json({ error: `no git remote named ${forgeRemote}` }, 400)
        }
        const known = listForgeCredentials()
        for (const kind of ForgeKind.options) {
          const id = forgeCredentials?.[kind]
          if (id != null && !known.some((cred) => cred.id === id && cred.kind === kind)) {
            return c.json({ error: `unknown ${kind} credential ${id}` }, 400)
          }
        }
        for (const kind of ForgeKind.options) {
          const id = forgeCredentials?.[kind]
          if (id !== undefined) pickForgeCredential(ws.root, kind, id)
        }
        writeConfig(ws.root, {
          ...(forgeKind === undefined && forgeRemote === undefined
            ? {}
            : {
                forge: {
                  ...(forgeKind === undefined ? {} : { kind: forgeKind }),
                  remote: forgeRemote ?? null,
                },
              }),
          ...(autoQueue === undefined ? {} : { loop: { autoQueue } }),
          ...(ntfyTopic === undefined &&
          ntfyServer === undefined &&
          desktopFailureAlerts === undefined
            ? {}
            : {
                notify: {
                  ...(ntfyTopic === undefined ? {} : { ntfyTopic }),
                  ...(ntfyServer === undefined ? {} : { ntfyServer }),
                  ...(desktopFailureAlerts === undefined ? {} : { desktopFailureAlerts }),
                },
              }),
          ...(reviewMaxRounds === undefined ? {} : { review: { maxRounds: reviewMaxRounds } }),
        })
        if (ntfyTopic !== undefined) ws.config.notify.ntfyTopic = ntfyTopic
        if (ntfyServer !== undefined) ws.config.notify.ntfyServer = ntfyServer
        if (desktopFailureAlerts !== undefined) {
          ws.config.notify.desktopFailureAlerts = desktopFailureAlerts
        }
        if (reviewMaxRounds !== undefined) ws.config.review.maxRounds = reviewMaxRounds
        if (
          forgeKind !== undefined ||
          forgeRemote !== undefined ||
          forgeCredentials !== undefined
        ) {
          const { kind, remote } = loadConfig(ws.root).config.forge
          ws.config.forge.kind = kind
          ws.config.forge.remote = remote
        }
        if (autoQueue !== undefined) {
          ws.config.loop.autoQueue = autoQueue
          const service = runnerFor(repo)
          if (service !== undefined) {
            const workersEnabled =
              workspaces.list().find((entry) => entry.key === repo)?.workers === true
            service.setAutoQueue(autoQueue && workersEnabled)
          }
        }
        return c.json({
          autoQueue: ws.config.loop.autoQueue,
          ntfyTopic: ws.config.notify.ntfyTopic,
          ntfyServer: ws.config.notify.ntfyServer,
          desktopFailureAlerts: ws.config.notify.desktopFailureAlerts,
          reviewMaxRounds: ws.config.review.maxRounds,
          forgeKind: ws.config.forge.kind,
          forgeRemote: ws.config.forge.remote,
          forgeRemotePinned: hasPinnedForgeRemote(ws.root),
          remotes,
          forgeCredentials: forgeTokenStates(ws.root),
        })
      },
    )

    .get('/api/forge-credentials', (c) => c.json({ credentials: listForgeCredentials() }))

    .post('/api/forge-credentials', valid('json', ForgeCredentialCreateBody), (c) => {
      const { kind, name, token, url } = c.req.valid('json')
      return c.json(addForgeCredential(kind, name, token, url ?? null))
    })

    .patch(
      '/api/forge-credentials/:id',
      valid('param', ForgeCredentialParam),
      valid('json', ForgeCredentialUpdateBody),
      (c) => {
        const credential = updateForgeCredential(c.req.valid('param').id, c.req.valid('json'))
        return credential === null
          ? c.json({ error: 'unknown credential' }, 404)
          : c.json(credential)
      },
    )

    .delete('/api/forge-credentials/:id', valid('param', ForgeCredentialParam), (c) =>
      removeForgeCredential(c.req.valid('param').id)
        ? c.json({ ok: true })
        : c.json({ error: 'unknown credential' }, 404),
    )

    .post('/api/repos/:repo/settings/test-desktop', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      resolveWorkspace(workspaces, repo)
      try {
        await new LibnotifyNotifier().notify('Amagi desktop test', 'Desktop notifications work.')
        return c.json({ ok: true })
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500)
      }
    })

    .post('/api/repos/:repo/settings/test-ntfy', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { ntfyTopic, ntfyServer } = ws.config.notify
      if (!ntfyTopic) return c.json({ error: 'Configure an ntfy topic first' }, 400)
      try {
        await new NtfyNotifier(ntfyTopic, ntfyServer).notify(
          'Amagi ntfy test',
          'ntfy notifications work.',
        )
        return c.json({ ok: true })
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500)
      }
    })

    .patch(
      '/api/repos/:repo/participation',
      valid('param', RepoParam),
      valid('json', ParticipationBody),
      (c) => {
        const { repo } = c.req.valid('param')
        const body = c.req.valid('json')
        const participation = {
          ...(body.workers === undefined ? {} : { workers: body.workers }),
          ...(body.watchers === undefined ? {} : { watchers: body.watchers }),
        }
        if (!workspaces.updateParticipation(repo, participation)) {
          return c.json({ error: `unknown repository ${repo}` }, 404)
        }
        const service = runnerFor(repo)
        if (body.workers !== undefined && service !== undefined) {
          service.setAutoQueue(
            resolveWorkspace(workspaces, repo).config.loop.autoQueue && body.workers,
          )
        }
        const entry = workspaces.list().find((e) => e.key === repo)
        return c.json({ workers: entry?.workers ?? false, watchers: entry?.watchers ?? false })
      },
    )

    .get('/api/repos/:repo/git-identity', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const entry = workspaces.list().find((candidate) => candidate.key === repo)
      if (entry === undefined) return c.json({ error: `unknown repository ${repo}` }, 404)
      return c.json({ gitIdentity: entry.gitIdentity })
    })

    .patch(
      '/api/repos/:repo/git-identity',
      valid('param', RepoParam),
      valid('json', GitIdentityBody),
      (c) => {
        const { repo } = c.req.valid('param')
        let gitIdentity: GitIdentity | null
        try {
          gitIdentity = validateGitIdentity(c.req.valid('json'))
        } catch (err) {
          return c.json({ error: errMsg(err) }, 400)
        }
        if (!workspaces.updateGitIdentity(repo, gitIdentity)) {
          return c.json({ error: `unknown repository ${repo}` }, 404)
        }
        return c.json({ gitIdentity })
      },
    )

    .get('/api/workers', async (c) =>
      c.json({
        workers: await fleetView(),
        difficultyLevels: loadGlobalConfig().difficulty.levels,
      }),
    )

    .post('/api/workers', valid('json', WorkerCreateBody), async (c) => {
      const fleet = loadGlobalConfig().worker
      const parsed = WorkerConfig.safeParse({
        id: newWorkerId(fleet.map((w) => w.id)),
        ...c.req.valid('json'),
      })
      if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)
      const next = Config.shape.worker.safeParse([...fleet, parsed.data])
      if (!next.success) return c.json({ error: z.prettifyError(next.error) }, 400)
      saveFleet(next.data)
      return c.json({ ...parsed.data, taskId: null }, 201)
    })

    .patch(
      '/api/workers/:id',
      valid('param', TaskIdParam),
      valid('json', WorkerUpdateBody),
      async (c) => {
        const { id } = c.req.valid('param')
        const fields = c.req.valid('json')
        const fleet = loadGlobalConfig().worker
        const current = fleet.find((w) => w.id === id)
        if (current === undefined) return c.json({ error: `unknown worker ${id}` }, 404)
        const merged: Record<string, unknown> = { ...current }
        for (const [key, value] of Object.entries(fields)) {
          if (value === null) delete merged[key]
          else if (value !== undefined) merged[key] = value
        }
        const parsed = WorkerConfig.safeParse(merged)
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)
        const worker = parsed.data
        const next = Config.shape.worker.safeParse(fleet.map((w) => (w.id === id ? worker : w)))
        if (!next.success) return c.json({ error: z.prettifyError(next.error) }, 400)
        saveFleet(next.data)
        return c.json((await fleetView()).find((w) => w.id === id))
      },
    )

    .delete('/api/workers/:id', valid('param', TaskIdParam), async (c) => {
      const { id } = c.req.valid('param')
      const fleet = loadGlobalConfig().worker
      if (!fleet.some((w) => w.id === id)) return c.json({ error: `unknown worker ${id}` }, 404)
      const running = (await fleetView()).find((w) => w.id === id)?.taskId ?? null
      if (running !== null) {
        return c.json(
          { error: `worker ${id} is running ${running}; stop that run before deleting the worker` },
          409,
        )
      }
      saveFleet(fleet.filter((w) => w.id !== id))
      return c.json({ id })
    })

    .get('/api/watchers', (c) => c.json(loadGlobalConfig().watchers))

    .patch(
      '/api/watchers/:kind',
      valid('param', WatcherParam),
      valid('json', WatcherUpdateBody),
      (c) => {
        const { kind } = c.req.valid('param')
        const patch = c.req.valid('json')
        if (kind === 'stall' && Object.keys(patch).some((key) => key !== 'enabled')) {
          return c.json(
            { error: 'the stall watcher spawns no agent; only enabled can be set' },
            400,
          )
        }
        // No live mutation here: the serve supervisor re-reads watcher config
        // from disk on every tick and starts or stops watchers to match.
        writeGlobalConfig({ watchers: { [kind]: patch } })
        return c.json(loadGlobalConfig().watchers[kind])
      },
    )
}
