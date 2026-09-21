import { join } from 'node:path'
import {
  addRegistryEntry,
  loadGlobalConfig,
  loadRegistry,
  makeHarness,
  RunService,
  repoRoot,
  Workspaces,
} from '@amagi/core'
import { serve } from '@amagi/server'
import { defineCommand } from 'citty'
import { bold, dim } from '../format.ts'

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Serve the API and dashboard for every registered repository',
  },
  run() {
    // Out of the box, register the repo the operator is standing in so the
    // dashboard has a workspace on first run.
    if (loadRegistry().length === 0) {
      try {
        addRegistryEntry(repoRoot())
      } catch {
        // not inside a repo; the dashboard can onboard one
      }
    }
    const config = loadGlobalConfig()
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
            ...(ws.forge === null ? {} : { forge: ws.forge }),
          })
        }
      } catch (err) {
        console.warn(
          `runner for ${primary.key} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    const server = serve({
      workspaces,
      host: config.server.host,
      port: config.server.port,
      staticDir: join(import.meta.dir, '..', '..', '..', 'dashboard', 'dist'),
      ...(runner === undefined || primary === undefined ? {} : { runner, runnerRepo: primary.key }),
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
