import { loadConfig, repoRoot } from '@amagi/core'
import { renderTui } from '@amagi/tui'
import { defineCommand } from 'citty'
import { currentRepo } from '../repo.ts'

export const tuiCommand = defineCommand({
  meta: {
    name: 'tui',
    description: 'Terminal view of the queue, task detail, and pending questions',
  },
  async run() {
    const { config } = loadConfig(repoRoot())
    const { key } = currentRepo()
    const instance = renderTui({
      baseUrl: `http://${config.server.host}:${config.server.port}`,
      repo: key,
    })
    await instance.waitUntilExit()
  },
})
