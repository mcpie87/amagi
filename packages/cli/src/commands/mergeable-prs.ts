import { errMsg, loadConfig, makePrDriver, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red, table } from '../format.ts'

export const mergeablePrsCommand = defineCommand({
  meta: {
    name: 'mergeable-prs',
    description: 'List open pull requests that are currently mergeable, for the configured forge',
  },
  async run() {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const forge = makePrDriver(config.forge.kind)

    let prs: Awaited<ReturnType<typeof forge.listOpenPrs>>
    try {
      prs = await forge.listOpenPrs(root)
    } catch (err) {
      console.log(red(`failed to list PRs: ${errMsg(err)}`))
      return
    }

    const mergeable = prs.filter((p) => p.mergeStatus === 'mergeable')
    if (mergeable.length === 0) {
      console.log(dim('no mergeable pull requests'))
      return
    }

    const header = ['PR', 'BASE', 'HEAD', 'TITLE']
    const rows = mergeable.map((p) => [`#${p.number}`, p.baseRefName, p.headRefName, p.title])
    console.log(
      table([header, ...rows], (row, i) => {
        if (i === 0) return row.map(bold)
        return row.map((c, j) => (j === 0 ? green(c) : c))
      }),
    )
    for (const p of mergeable) console.log(dim(p.url))
  },
})
