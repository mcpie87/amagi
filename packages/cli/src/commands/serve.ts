import { join } from 'node:path'
import {
  addRegistryEntry,
  errMsg,
  loadGlobalConfig,
  loadRegistry,
  makeHarness,
  migrateFleet,
  RunService,
  repoRoot,
  Workspaces,
} from '@amagi/core'
import { portInUse, serve } from '@amagi/server'
import { defineCommand } from 'citty'
import { bold, dim } from '../format.ts'

/**
 * Rebuilds the dashboard dist so the served UI always matches the current
 * source (transition rules, components). A stale dist is what blanked the
 * dashboard in the past when a merge added a new task transition.
 */
async function buildDashboard(dashboardDir: string): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: dashboardDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  const exit = await proc.exited
  if (exit !== 0) {
    throw new Error(`dashboard build failed (exit ${exit}); refusing to serve a stale UI`)
  }
}

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Serve the API and dashboard for every registered repository',
  },
  async run() {
    // Out of the box, register the repo the operator is standing in so the
    // dashboard has a workspace on first run.
    if (loadRegistry().length === 0) {
      try {
        addRegistryEntry(repoRoot())
      } catch {
        // not inside a repo; the dashboard can onboard one
      }
    }
    for (const w of migrateFleet()) {
      console.log(`${bold('amagi')} created worker ${w.name} (${w.id}) on seat ${w.seat}`)
    }
    const config = loadGlobalConfig()
    // Checked before the dashboard build so a second `amagi serve` fails in a
    // second instead of rebuilding the UI and only then dying on the bind.
    if (portInUse(config.server.host, config.server.port)) {
      console.error(
        `${bold('amagi')} cannot bind ${config.server.host}:${config.server.port} - it is already in use.`,
      )
      console.error(
        dim(
          'Another `amagi serve` is probably running; stop it, or set server.port in the global config.',
        ),
      )
      process.exit(1)
    }
    const dashboardDir = join(import.meta.dir, '..', '..', '..', 'dashboard')
    await buildDashboard(dashboardDir)
    const workspaces = new Workspaces()
    // The operator-facing runner service is bound to the repo the server is
    // launched from, so the dashboard's launch/stop controls have one target.
    const primary = workspaces.list()[0]
    let runner: RunService | undefined
    if (primary !== undefined) {
      try {
        const ws = workspaces.get(primary.key)
        if (ws !== null) {
          runner = new RunService({
            store: ws.store,
            tracker: ws.tracker,
            harness: makeHarness(ws.config.harness.implement),
            config: ws.config,
            repoRoot: ws.root,
            repoName: ws.name,
            autoQueue: ws.config.loop.autoQueue && primary.workers,
            ...(ws.forge === null ? {} : { forge: ws.forge }),
          })
        }
      } catch (err) {
        console.warn(`runner for ${primary.key} unavailable: ${errMsg(err)}`)
      }
    }
    const server = serve({
      workspaces,
      host: config.server.host,
      port: config.server.port,
      staticDir: join(dashboardDir, 'dist'),
      runner,
      runnerRepo: primary?.key,
    })
    console.log(`${bold('amagi')} dashboard + api: ${server.url}`)
    for (const entry of workspaces.list()) {
      console.log(dim(`  repo ${entry.key}: ${entry.path}`))
    }
    console.log(dim('ctrl-c to stop'))
    process.on('SIGINT', () => {
      server.stop().finally(() => process.exit(0))
    })
  },
})
