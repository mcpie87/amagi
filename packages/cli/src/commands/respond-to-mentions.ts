import {
  listOpenPrs,
  listPrMentions,
  loadConfig,
  makePrDriver,
  makeTracker,
  mentionsPath,
  type PrComment,
  type PrInfo,
  readHandledMentions,
  repoName,
  repoRoot,
  respondToMention,
  saveHandledMentions,
} from '@amagi/core'
import { defineCommand } from 'citty'
import { bold, dim, green, red } from '../format.ts'

export const respondToMentionsCommand = defineCommand({
  meta: {
    name: 'respond-to-mentions',
    description: 'Watch open PRs for @agent mentions and respond (fix, explain, or ask)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Only list mentions; do not dispatch agents or post comments',
      default: false,
    },
  },
  async run({ args }) {
    const root = repoRoot()
    const { config } = loadConfig(root)
    const name = repoName(root)
    const driver = makePrDriver(config.forge.kind)
    const tracker = makeTracker(config, root)
    const handle = config.forge.agentHandle

    let prs: PrInfo[]
    try {
      prs = await listOpenPrs({ cwd: root })
    } catch (err) {
      console.log(
        red(
          `failed to list PRs: ${err instanceof Error ? err.message : String(err)} (is gh installed and authenticated?)`,
        ),
      )
      return
    }
    if (prs.length === 0) {
      console.log(dim('no open pull requests'))
      return
    }

    const path = mentionsPath(name)
    const handled = readHandledMentions(path)
    let total = 0

    for (const pr of prs) {
      let mentions: PrComment[]
      try {
        mentions = await listPrMentions({ driver, cwd: root, pr, handle })
      } catch (err) {
        console.log(
          red(
            `#${pr.number}: failed to read comments: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        continue
      }
      if (mentions.length === 0) continue
      console.log(`\n${bold(`#${pr.number}`)}  ${pr.title}`)
      console.log(dim(`  ${pr.url}`))
      for (const mention of mentions) {
        if (handled.has(mention.id)) continue
        total++
        console.log(`  @${mention.user}: ${mention.body.trim().replace(/\s+/g, ' ').slice(0, 120)}`)
        if (args['dry-run']) continue
        try {
          const kind = await respondToMention({
            root,
            repoName: name,
            pr,
            mention,
            config,
            driver,
            tracker,
          })
          handled.add(mention.id)
          saveHandledMentions(path, handled)
          console.log(green(`  responded (${kind})`))
        } catch (err) {
          console.log(red(`  failed: ${err instanceof Error ? err.message : String(err)}`))
        }
      }
    }

    if (total === 0) console.log(dim('\nno unhandled agent mentions'))
    else if (args['dry-run']) console.log(dim(`\n${total} mention(s); dry run, nothing dispatched`))
  },
})
