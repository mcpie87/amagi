import { loadConfig, repoRoot } from '@amagi/core'
import { renderTui } from '@amagi/tui'
import { defineCommand } from 'citty'

export const tuiCommand = defineCommand({
  meta: {
    name: 'tui',
    description: 'Terminal view of the queue, task detail, and pending questions',
  },
  async run() {
    const { config } = loadConfig(repoRoot())
    const instance = renderTui({ baseUrl: `http://${config.server.host}:${config.server.port}` })
    await instance.waitUntilExit()
  },
})
