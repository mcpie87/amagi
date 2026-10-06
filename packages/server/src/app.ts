import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  ChatService,
  claimGate,
  errMsg,
  expandTilde,
  expandWorkers,
  type GitIdentity,
  type LiveRun,
  loadConfig,
  loadGlobalConfig,
  loadWatcherSeats,
  makeHarness,
  type Notifier,
  pidAlive,
  type Question,
  type RegistryEntry,
  type RunServiceApi,
  type Store,
  type Tracker,
  Triage,
  type WorkerActivity,
  type WorkerConfig,
  type Workspace,
  type Workspaces,
  watcherHarnessConfig,
  workerSeat,
  writeGlobalConfig,
} from '@amagi/core'
import type { Harness } from '@amagi/core/drivers/types'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { createFleetRoutes } from './fleet-routes.ts'
import { createIssueRoutes } from './issues-routes.ts'
import { RepoError, resolveWorkspace, valid } from './route-utils.ts'
import {
  EventQuery,
  QuestionQuery,
  RepoCommitParam,
  RepoParam,
  RepoRegisterBody,
  SeatNamesUpdateBody,
  StreamQuery,
} from './schemas.ts'
import { eventStream } from './stream.ts'
import { createTaskRoutes } from './task-routes.ts'

export type ServerDeps = {
  workspaces: Workspaces
  notify?: Notifier[] | undefined
  /** When present, the launch/stop runner endpoints are live. */
  runner?: RunServiceApi | undefined
  /** The repo key the runner is bound to, so settings apply live only to it. */
  runnerRepo?: string | undefined
  /** Per-repository server runner, including workspaces registered at runtime. */
  runnerForRepo?: (repo: string) => RunServiceApi | undefined
  /** Synchronizes runner instances after registry changes. */
  syncRunners?: () => void
  /** Background worker activity (e.g. mention watchers), merged into repo runner status. */
  workers?: () => WorkerActivity[]
  /** Queues one PR on the existing conflict watcher. */
  queueConflictResolution?: (repo: string, prNumber: number, prUrl: string | null) => boolean
  /** Foreground CLI workers (`just run`) outside the server runner. */
  liveRuns?: () => LiveRun[]
  /** Overridable so tests stub the harness a workspace's chat uses. */
  chatHarnessFor?: (ws: Workspace) => Harness
}

function validateGitIdentity(identity: GitIdentity | null): GitIdentity | null {
  if (identity === null) return null
  if (identity.mode === 'path') {
    const file = resolve(expandTilde(identity.value))
    try {
      accessSync(file, fsConstants.R_OK)
      if (!statSync(file).isFile()) throw new Error('not a file')
    } catch {
      throw new Error(`gitconfig file is not readable: ${file}`)
    }
    return { mode: 'path', value: file }
  }

  const dir = mkdtempSync(`${tmpdir()}/amagi-gitconfig-`)
  const file = `${dir}/identity.gitconfig`
  try {
    writeFileSync(file, identity.value)
    const result = Bun.spawnSync(['git', 'config', '--file', file, '--list'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      const message = result.stderr.toString().trim() || 'invalid gitconfig'
      throw new Error(message)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return identity
}

/**
 * The agent carries AMAGI_TASK_TOKEN in its environment; a question is bound
 * to the task that spawned it, so one agent cannot answer for another.
 */
const authorized = (c: Context, store: Store, id: string): boolean =>
  c.req.header('X-Amagi-Token') === store.token(id)

/**
 * Best effort: a notifier (e.g. a missing notify-send) must never break the
 * ask request. Desktop failures are recorded separately when their dashboard
 * alert is enabled; other failures remain best effort.
 */
async function notifyChannels(
  notifiers: Notifier[],
  store: Store,
  title: string,
  body: string,
  desktopFailureAlerts = false,
): Promise<void> {
  for (const notifier of notifiers) {
    try {
      await notifier.notify(title, body)
    } catch (err) {
      const detail = errMsg(err)
      console.warn(`notify ${notifier.kind}: ${detail}`)
      if (notifier.kind === 'libnotify' && desktopFailureAlerts) {
        store.append(null, { type: 'notify.failed', channel: notifier.kind, title, detail })
        continue
      }
    }
    store.append(null, { type: 'notify.sent', channel: notifier.kind, title })
  }
}

/**
 * A gate is a courtesy, not a prerequisite: if the tracker cannot open one the
 * question still lands in the store and the notifiers still fire, so the agent
 * is never stranded by a tracker hiccup.
 */
async function openQuestionGate(
  tracker: Tracker | undefined,
  taskId: string,
  question: Question,
): Promise<string | null> {
  if (tracker === undefined) return null
  try {
    return (await tracker.openGate(taskId, question)).id
  } catch (err) {
    console.warn(`openGate ${taskId}: ${errMsg(err)}`)
    return null
  }
}

async function resolveQuestionGate(
  tracker: Tracker | undefined,
  gateRef: string | null,
): Promise<void> {
  if (tracker === undefined || gateRef === null) return
  try {
    await tracker.resolveGate({ id: gateRef, advisory: false })
  } catch (err) {
    console.warn(`resolveGate ${gateRef}: ${errMsg(err)}`)
  }
}

function gitOutput(root: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || 'git command failed')
  }
  return result.stdout.toString()
}

export function createApp({
  workspaces,
  notify = [],
  runner,
  runnerRepo,
  runnerForRepo,
  syncRunners,
  workers,
  queueConflictResolution,
  liveRuns,
  chatHarnessFor,
}: ServerDeps) {
  // One ChatService per workspace, so the in-flight guard survives requests.
  const chats = new Map<string, ChatService>()
  const chatFor = (ws: Workspace): ChatService => {
    let chat = chats.get(ws.key)
    if (chat === undefined) {
      const harness = chatHarnessFor?.(ws) ?? makeHarness(ws.config.harness.implement)
      chat = new ChatService({ store: ws.store, harness, config: ws.config })
      chats.set(ws.key, chat)
    }
    return chat
  }
  const runnerFor = (repo: string): RunServiceApi | undefined => {
    const service = runnerForRepo?.(repo)
    if (service !== undefined) return service
    if (runnerRepo !== undefined) return runnerRepo === repo ? runner : undefined
    return workspaces.list().length === 1 ? runner : undefined
  }
  const servedRunners = (): { repo: string; service: RunServiceApi }[] =>
    workspaces.list().flatMap((entry) => {
      const service = runnerFor(entry.key)
      return service === undefined ? [] : [{ repo: entry.key, service }]
    })
  // The global config on disk is the fleet's truth; each served runner reads its
  // own workspace's copy, so a save has to replace those copies too to live-apply.
  const saveFleet = (fleet: WorkerConfig[]): void => {
    writeGlobalConfig({ worker: fleet })
    for (const { repo, service } of servedRunners()) {
      resolveWorkspace(workspaces, repo).config.worker = fleet
      service.fleetChanged()
    }
  }
  const fleetView = async () => {
    const statuses = await Promise.all(servedRunners().map(({ service }) => service.status()))
    const live = statuses.flatMap((status) => status.fleet ?? [])
    return loadGlobalConfig().worker.map((worker) => {
      const state = live.find((w) => w.id === worker.id && w.taskId !== null)
      return { ...worker, taskId: state?.taskId ?? null }
    })
  }
  const seatReferences = () => {
    const global = loadGlobalConfig()
    const seats = new Map(global.seats.map(({ name, count }) => [name, count]))
    for (const worker of global.worker) {
      if (worker.seat !== undefined && !seats.has(worker.seat)) seats.set(worker.seat, 1)
    }
    for (const watcher of [global.watchers.mention, global.watchers.prConflict]) {
      if (watcher.seat !== undefined && !seats.has(watcher.seat)) seats.set(watcher.seat, 1)
    }
    for (const harness of [
      global.harness.implement,
      global.harness.triage,
      ...(global.review.harness ? [global.review.harness] : []),
      ...Object.values(global.harness.definitions),
    ]) {
      if (harness.seat !== undefined && !seats.has(harness.seat)) seats.set(harness.seat, 1)
    }
    return { global, seats }
  }
  return new Hono()
    .route('/', createIssueRoutes(workspaces))

    .get('/api/health', (c) => c.json({ ok: true }))

    .get('/api/usage-rates', (c) => {
      const windowMs = 60_000
      const since = Date.now() - windowMs
      const groups = new Map<string, { seat: string; calls: number; tokens: number }>()
      for (const entry of workspaces.list()) {
        const ws = workspaces.get(entry.key)
        if (ws === null) continue
        for (const event of ws.store.eventsSince(since)) {
          if (event.type !== 'agent.stream' || event.event.kind !== 'usage') continue
          const seat = event.event.seat ?? 'Unassigned / seat not recorded'
          const group = groups.get(seat) ?? { seat, calls: 0, tokens: 0 }
          group.calls++
          group.tokens += event.event.inputTokens + event.event.outputTokens
          groups.set(seat, group)
        }
      }
      return c.json({ windowSeconds: 60, rates: [...groups.values()] })
    })

    .get('/api/seat-names', (c) => {
      const { seats } = seatReferences()
      return c.json({
        seats: [...seats]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, count]) => ({ name, count })),
      })
    })

    .put('/api/seat-names', valid('json', SeatNamesUpdateBody), (c) => {
      const { seats: seatEntries, renames } = c.req.valid('json')
      const seats = seatEntries.map(({ name }) => name)
      const { global, seats: referencedSeats } = seatReferences()
      const current = new Set(referencedSeats.keys())

      const renameMap = new Map<string, string>()
      for (const { from, to } of renames) {
        if (!current.has(from)) return c.json({ error: `unknown seat ${from}` }, 400)
        if (!seats.includes(to)) return c.json({ error: `renamed seat ${to} is not defined` }, 400)
        if (from === to || renameMap.has(from)) {
          return c.json({ error: `invalid rename for seat ${from}` }, 400)
        }
        renameMap.set(from, to)
      }

      const rewrite = (seat: string | undefined): string | undefined => {
        if (seat === undefined) return undefined
        const next = renameMap.get(seat) ?? seat
        return seats.includes(next) ? next : undefined
      }
      const worker = global.worker.map((entry) => {
        const seat = rewrite(entry.seat)
        if (seat === entry.seat) return entry
        const rest = { ...entry }
        delete rest.seat
        return seat === undefined ? rest : { ...rest, seat }
      })
      const watchers: Record<string, unknown> = {}
      for (const kind of ['mention', 'prConflict'] as const) {
        const original = global.watchers[kind]
        const seat = rewrite(original.seat)
        if (seat !== original.seat) watchers[kind] = { seat: seat ?? null }
      }
      const harness: Record<string, unknown> = {}
      for (const name of ['implement', 'triage'] as const) {
        const original = global.harness[name]
        const seat = rewrite(original.seat)
        if (seat !== original.seat) harness[name] = { kind: original.kind, seat: seat ?? null }
      }
      const definitions: Record<string, { seat: string | null }> = {}
      for (const [name, original] of Object.entries(global.harness.definitions)) {
        const seat = rewrite(original.seat)
        if (seat !== original.seat) definitions[name] = { seat: seat ?? null }
      }
      if (Object.keys(definitions).length > 0) harness.definitions = definitions
      const reviewer = global.review.harness
      const reviewerSeat = rewrite(reviewer?.seat)

      writeGlobalConfig({
        seats: seatEntries,
        worker,
        ...(Object.keys(watchers).length === 0 ? {} : { watchers }),
        ...(Object.keys(harness).length === 0 ? {} : { harness }),
        ...(reviewer === undefined || reviewerSeat === reviewer.seat
          ? {}
          : { review: { harness: { kind: reviewer.kind, seat: reviewerSeat ?? null } } }),
      })
      for (const entry of workspaces.list()) {
        const ws = workspaces.get(entry.key)
        if (ws === null) continue
        const { config } = loadConfig(ws.root)
        ws.config.seats = config.seats
        ws.config.worker = config.worker
        ws.config.watchers = config.watchers
        ws.config.harness = config.harness
        ws.config.review = config.review
        runnerFor(entry.key)?.fleetChanged()
      }
      return c.json({ seats: [...seatEntries].sort((a, b) => a.name.localeCompare(b.name)) })
    })

    .get('/api/seats', async (c) => {
      type Holder = {
        repo: string
        taskId?: string
        title?: string
        watcher?: string
        status?: string
        since?: number | null
      }
      type QueuedTask = {
        repo: string
        taskId: string
        title: string
        status: string
        since: number | null
      }
      const configured = new Set<string>()
      const global = loadGlobalConfig()
      for (const { name, count } of global.seats) {
        for (let slot = 1; slot <= count; slot++)
          configured.add(count === 1 ? name : `${name}-${slot}`)
      }
      const configuredNames = new Set(global.seats.map(({ name }) => name))
      for (const worker of expandWorkers(global.worker, global.seats)) {
        configured.add(workerSeat(worker))
      }
      for (const entry of workspaces.list()) {
        const ws = workspaces.get(entry.key)
        if (ws === null) continue
        const implementSeat = ws.config.harness.implement.seat ?? ws.config.harness.implement.kind
        if (!configuredNames.has(implementSeat)) configured.add(implementSeat)
        for (const watcher of ['mention', 'prConflict'] as const) {
          const harness = watcherHarnessConfig(ws.config, watcher)
          const seat = harness.seat ?? harness.kind
          if (!configuredNames.has(seat)) configured.add(seat)
        }
      }

      const holders = new Map<string, Holder>()
      const waiters = new Map<string, QueuedTask[]>()
      const eligible = new Map<string, QueuedTask[]>()
      const setHolder = (seat: string | undefined, holder: Holder): void => {
        if (seat !== undefined && !holders.has(seat)) holders.set(seat, holder)
      }
      const addWaiter = (seat: string | undefined, waiter: QueuedTask): void => {
        if (seat === undefined) return
        const queue = waiters.get(seat) ?? []
        if (!queue.some((entry) => entry.repo === waiter.repo && entry.taskId === waiter.taskId)) {
          queue.push(waiter)
        }
        waiters.set(seat, queue)
      }

      const runners = servedRunners()
      const [statuses, queues] = await Promise.all([
        Promise.all(runners.map(({ service }) => service.status())),
        Promise.all(
          workspaces.list().map(async (entry) => {
            const ws = workspaces.get(entry.key)
            if (ws === null) return null
            const workers = expandWorkers(ws.config.worker, ws.config.seats).filter(
              (worker) => worker.enabled,
            )
            const ready = workers.length === 0 ? [] : await ws.tracker.ready()
            return { repo: entry.key, ws, workers, ready }
          }),
        ),
      ])

      for (const [index, { repo }] of runners.entries()) {
        const status = statuses[index]
        if (status === undefined) continue
        for (const taskId of status.running) {
          const task = status.tasks[taskId]
          const ws = workspaces.get(repo)
          const projected = ws?.store.task(taskId)
          const taskStatus = projected?.state ?? 'running'
          if (task?.waitingOnSeat) {
            addWaiter(task.seat, {
              repo,
              taskId,
              title: task?.title ?? projected?.title ?? taskId,
              status: taskStatus,
              since: task.waitingSince ?? status.startedAt[taskId] ?? null,
            })
          } else {
            setHolder(task?.seat, {
              repo,
              taskId,
              title: task?.title ?? projected?.title ?? taskId,
              status: taskStatus,
              since: task?.agentStartedAt ?? status.startedAt[taskId] ?? null,
            })
          }
        }
      }
      for (const run of liveRuns?.() ?? []) {
        if (!pidAlive(run.pid)) continue
        const ws = workspaces.get(run.repoKey)
        const projected = ws?.store.task(run.taskId)
        const events = ws?.store.events({ taskId: run.taskId, limit: 100_000 }) ?? []
        if (run.waitingOnSeat) {
          const waitingSince = events
            .filter(
              (event) =>
                event.type === 'agent.stream' &&
                event.event.kind === 'status' &&
                event.event.message.startsWith('waiting for seat '),
            )
            .at(-1)?.ts
          addWaiter(run.seat, {
            repo: run.repoKey,
            taskId: run.taskId,
            title: run.title,
            status: projected?.state ?? 'running',
            since: waitingSince ?? run.startedAt,
          })
        } else {
          const agentStartedAt = events.filter((event) => event.type === 'agent.started').at(-1)?.ts
          setHolder(run.seat, {
            repo: run.repoKey,
            taskId: run.taskId,
            title: run.title,
            status: projected?.state ?? 'running',
            since: agentStartedAt ?? run.startedAt,
          })
        }
      }
      for (const watcher of loadWatcherSeats()) {
        setHolder(watcher.seat, {
          repo: watcher.repo,
          watcher: watcher.watcher,
          status: 'watcher',
          since: null,
        })
      }
      for (const queue of queues) {
        if (queue === null) continue
        const { repo, ws, workers, ready } = queue
        for (const chat of ws.store.activeChatAgents()) {
          const startedAt = ws.store
            .events({ taskId: chat.taskId, limit: 100_000 })
            .filter((event) => event.type === 'agent.started' && event.role === 'chat')
            .at(-1)?.ts
          setHolder(chat.seat, {
            repo,
            taskId: chat.taskId,
            title: ws.store.task(chat.taskId)?.title ?? chat.taskId,
            status: 'chat',
            since: startedAt ?? null,
          })
        }

        if (workers.length === 0) continue
        const workersBySeat = new Map<string, (typeof workers)[number][]>()
        for (const worker of workers) {
          const seat = worker.seat ?? worker.kind
          const seatWorkers = workersBySeat.get(seat) ?? []
          seatWorkers.push(worker)
          workersBySeat.set(seat, seatWorkers)
        }
        for (const [seat, seatWorkers] of workersBySeat) {
          const tasks = eligible.get(seat) ?? []
          for (const task of ready) {
            const canRun = seatWorkers.some((worker) => claimGate(ws.config, task, worker).allowed)
            if (
              !canRun ||
              tasks.some((queued) => queued.repo === repo && queued.taskId === task.id)
            )
              continue
            tasks.push({
              repo,
              taskId: task.id,
              title: task.title,
              status: 'ready',
              since: task.createdAt ?? null,
            })
          }
          eligible.set(seat, tasks)
        }
      }

      return c.json({
        seats: [...new Set([...configured, ...holders.keys(), ...waiters.keys()])]
          .sort()
          .map((seat) => ({
            seat,
            state: holders.has(seat) ? 'held' : 'free',
            holder: holders.get(seat) ?? null,
            waiters: waiters.get(seat) ?? [],
            eligible: eligible.get(seat) ?? [],
          })),
      })
    })

    .get('/api/repos', async (c) => {
      const out = []
      for (const entry of workspaces.list()) {
        try {
          const ready = await workspaces.diagnose(entry)
          out.push({
            key: entry.key,
            name: entry.name,
            path: entry.path,
            workers: entry.workers,
            watchers: entry.watchers,
            ready,
          })
        } catch (err) {
          out.push({
            key: entry.key,
            name: entry.name,
            path: entry.path,
            workers: entry.workers,
            watchers: entry.watchers,
            ready: [
              {
                name: 'workspace',
                ok: false,
                detail: errMsg(err),
              },
            ],
          })
        }
      }
      return c.json(out)
    })

    .get('/api/repos/:repo/git/log', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      try {
        const output = gitOutput(ws.root, ['log', '-100', '--format=%H%x00%s%x00%ct%x1e'])
        const commits = output
          .split('\x1e')
          .map((record) => record.trim())
          .filter(Boolean)
          .map((record) => {
            const [hash, title, timestamp] = record.split('\x00')
            return { hash, title, timestamp: Number(timestamp) }
          })
        return c.json({ commits })
      } catch (err) {
        return c.json({ error: errMsg(err) }, 500)
      }
    })

    .get('/api/repos/:repo/git/commits/:hash', valid('param', RepoCommitParam), (c) => {
      const { repo, hash } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      try {
        const resolved = gitOutput(ws.root, ['rev-parse', '--verify', `${hash}^{commit}`]).trim()
        const [title, timestamp, authorName, authorEmail, ...bodyParts] = gitOutput(ws.root, [
          'show',
          '-s',
          '--format=%s%x00%ct%x00%an%x00%ae%x00%b',
          resolved,
        ]).split('\x00')
        const parents = gitOutput(ws.root, ['show', '-s', '--format=%P', resolved]).trim()
        const patch =
          parents === ''
            ? gitOutput(ws.root, [
                'diff-tree',
                '--root',
                '--no-commit-id',
                '-p',
                '--no-renames',
                '-r',
                resolved,
              ])
            : gitOutput(ws.root, [
                'diff',
                '--no-ext-diff',
                '--no-renames',
                `${resolved}^`,
                resolved,
                '--',
              ])
        return c.json({
          hash: resolved,
          title,
          timestamp: Number(timestamp),
          author: authorEmail === '' ? authorName : `${authorName} <${authorEmail}>`,
          message: bodyParts.join('\x00').trim(),
          patch,
        })
      } catch (err) {
        return c.json({ error: errMsg(err) }, 404)
      }
    })

    .post('/api/repos', valid('json', RepoRegisterBody), async (c) => {
      const { path, key } = c.req.valid('json')
      let entry: RegistryEntry
      try {
        entry = workspaces.add(path, key)
      } catch (err) {
        return c.json({ error: errMsg(err) }, 400)
      }
      syncRunners?.()
      const ready = await workspaces.diagnose(entry)
      return c.json({ ...entry, ready }, 201)
    })

    .delete('/api/repos/:repo', valid('param', RepoParam), (c) => {
      const repo = c.req.valid('param').repo
      if (!workspaces.remove(repo)) {
        return c.json({ error: `unknown repository ${repo}` }, 404)
      }
      syncRunners?.()
      return c.json({ ok: true })
    })

    .get('/api/repos/:repo/ready', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const entry = workspaces.list().find((e) => e.key === repo)
      if (!entry) return c.json({ error: `unknown repository ${repo}` }, 404)
      return c.json(await workspaces.diagnose(entry))
    })

    .get('/api/repos/:repo/ready-queue', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      // The tracker orders the queue FCFS (bd ready --sort oldest).
      return c.json(await ws.tracker.ready())
    })

    .get('/api/repos/:repo/mergeable-prs', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      if (ws.forge === null) {
        return c.json({ error: `forge driver unavailable for ${repo}` }, 501)
      }
      // The driver reports the forge's own flags (gh wording on both drivers),
      // so one filter is all it takes to find the PRs that can merge now.
      const open = await ws.forge.listOpenPrs(ws.root)
      return c.json({
        prs: open.filter((p) => p.mergeable === 'MERGEABLE' || p.mergeStateStatus === 'CLEAN'),
      })
    })

    .get('/api/repos/:repo/open-prs', valid('param', RepoParam), async (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      if (ws.forge === null) {
        return c.json({ error: `forge driver unavailable for ${repo}` }, 501)
      }
      return c.json({ prs: await ws.forge.listOpenPrs(ws.root) })
    })

    .route(
      '/',
      createTaskRoutes({
        workspaces,
        notify,
        runnerFor,
        workers,
        liveRuns,
        queueConflictResolution,
        chatFor,
        authorized,
        openQuestionGate,
        resolveQuestionGate,
        notifyChannels,
      }),
    )

    .route(
      '/',
      createFleetRoutes({ workspaces, runnerFor, saveFleet, fleetView, validateGitIdentity }),
    )

    .get('/api/repos/:repo/events', valid('param', RepoParam), valid('query', EventQuery), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { taskId, sinceSeq, limit } = c.req.valid('query')
      return c.json(ws.store.events(taskId ? { taskId, sinceSeq, limit } : { sinceSeq, limit }))
    })

    .get('/api/repos/:repo/stream', valid('param', RepoParam), valid('query', StreamQuery), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const { taskId, sinceSeq, compact } = c.req.valid('query')
      // A browser resends the last id it saw on reconnect; that beats whatever
      // sinceSeq was baked into the EventSource url when it first connected.
      const resumed = Number(c.req.header('Last-Event-ID'))
      const isResume = Number.isInteger(resumed) && resumed >= 0
      const from = isResume ? resumed : sinceSeq
      // The url still asks for compact on a resume, but the client counts on
      // the log lines it missed since the first replay.
      const opts = { sinceSeq: from, compact: compact && !isResume }
      return eventStream(c, ws.store, taskId === undefined ? opts : { taskId, ...opts })
    })

    .get(
      '/api/repos/:repo/questions',
      valid('param', RepoParam),
      valid('query', QuestionQuery),
      (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const { taskId } = c.req.valid('query')
        return c.json(ws.store.openQuestions(taskId))
      },
    )

    .post('/api/repos/:repo/triage', valid('param', RepoParam), (c) => {
      const { repo } = c.req.valid('param')
      const ws = resolveWorkspace(workspaces, repo)
      const triage = new Triage({
        store: ws.store,
        tracker: ws.tracker,
        harness: makeHarness(ws.config.harness.triage),
        config: ws.config,
        repoRoot: ws.root,
        repoName: ws.name,
        ...(ws.forge === null ? {} : { forge: ws.forge }),
      })
      // Triage may hand off to a long implementation run; the request returns
      // immediately and every decision reports through the repo's event stream.
      void triage.triageOnce().catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        ws.store.append(null, { type: 'error', message, fatal: false })
      })
      return c.json({ repo, started: true }, 202)
    })

    .notFound((c) => c.json({ error: `no route for ${c.req.method} ${c.req.path}` }, 404))

    .onError((err, c) => {
      if (err instanceof RepoError) return c.json({ error: err.message }, err.status)
      console.error(err)
      return c.json({ error: err.message }, 500)
    })
}

export type AppType = ReturnType<typeof createApp>
