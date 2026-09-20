import { join } from 'node:path'
import { loadConfig, makePrDriver, repoRoot, Store } from '@amagi/core'
import { serve } from '@amagi/server'
import { defineCommand } from 'citty'
import { bold, dim } from '../format.ts'

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Serve the API and the built dashboard from one process',
  },
  run() {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const store = new Store()
    const server = serve({
      store,
      host: config.server.host,
      port: config.server.port,
      staticDir: join(root, 'packages', 'dashboard', 'dist'),
      forge: makePrDriver(config.forge.kind),
      forgeCwd: root,
    })
    console.log(`${bold('amagi')} dashboard + api: ${server.url}`)
    console.log(dim('ctrl-c to stop'))
    process.on('SIGINT', () => {
      server.stop().finally(() => process.exit(0))
    })
  },
})
