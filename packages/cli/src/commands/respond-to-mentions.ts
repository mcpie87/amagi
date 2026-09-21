import {
  errMsg,
  fmtDuration,
  fmtTokens,
  listOpenPrs,
  listPrMentions,
  loadConfig,
  type MentionProgress,
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
    description:
      'Watch open PRs for @agent mentions and have the LLM decide the response (fix, explain, add a task, or ask)',
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
    const tty = process.stdout.isTTY

    let prs: PrInfo[]
    try {
      prs = await listOpenPrs({ cwd: root })
    } catch (err) {
      console.log(red(`failed to list PRs: ${errMsg(err)} (is gh installed and authenticated?)`))
      return
    }
    if (prs.length === 0) {
      console.log(dim('no open pull requests'))
      return
    }

    const path = mentionsPath(name)
    const handled = readHandledMentions(path)
    let total = 0

    const progressLine = (p: MentionProgress): string => {
      const parts = [p.phase]
      if (p.tool) parts.push(p.tool)
      parts.push(`${fmtDuration(p.phaseMs)} / ${fmtDuration(p.totalMs)}`)
      if (p.usage) {
        parts.push(`${fmtTokens(p.usage.inputTokens)} in / ${fmtTokens(p.usage.outputTokens)} out`)
        if (p.usage.costUsd !== null) parts.push(`$${p.usage.costUsd.toFixed(3)}`)
      }
      return `  ${dim(parts.join('  '))}`
    }

    for (const pr of prs) {
      let mentions: PrComment[]
      try {
        mentions = await listPrMentions({ driver, cwd: root, pr, handle })
      } catch (err) {
        console.log(red(`#${pr.number}: failed to read comments: ${errMsg(err)}`))
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
        let lastNonTty = ''
        const render = (p: MentionProgress) => {
          const line = progressLine(p)
          if (tty) process.stdout.write(`\r\x1b[K${line}`)
          else if (line !== lastNonTty) {
            lastNonTty = line
            console.log(line)
          }
        }
        const clearLine = () => {
          if (tty) process.stdout.write('\r\x1b[K')
        }
        try {
          const kind = await respondToMention({
            root,
            repoName: name,
            pr,
            mention,
            config,
            driver,
            tracker,
            onProgress: render,
          })
          clearLine()
          handled.add(mention.id)
          saveHandledMentions(path, handled)
          console.log(green(`  responded (${kind})`))
        } catch (err) {
          clearLine()
          console.log(red(`  failed: ${errMsg(err)}`))
        }
      }
    }

    if (total === 0) console.log(dim('\nno unhandled agent mentions'))
    else if (args['dry-run']) console.log(dim(`\n${total} mention(s); dry run, nothing dispatched`))
  },
})
