import { join } from 'node:path'
import { addRegistryEntry, loadGlobalConfig, loadRegistry, repoRoot, Workspaces } from '@amagi/core'
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
    const server = serve({
      workspaces,
      host: config.server.host,
      port: config.server.port,
      staticDir: join(import.meta.dir, '..', '..', '..', 'dashboard', 'dist'),
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
