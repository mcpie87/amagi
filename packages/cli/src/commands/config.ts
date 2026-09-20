import { loadConfig, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { dim } from '../format.ts'

export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Print the resolved configuration and where it came from' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON only', default: false },
  },
  run({ args }) {
    const { config, sources } = loadConfig(repoRoot())
    if (args.json) {
      console.log(JSON.stringify(config, null, 2))
      return
    }
    console.log(
      dim(sources.length ? `sources: ${sources.join(', ')}` : 'sources: none (all defaults)'),
    )
    console.log(JSON.stringify(config, null, 2))
  },
})
