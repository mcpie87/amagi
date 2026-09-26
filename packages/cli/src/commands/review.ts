import { ejectReviewPack, repoRoot } from '@amagi/core'
import { defineCommand } from 'citty'

export const reviewCommand = defineCommand({
  meta: { name: 'review', description: 'Manage reviewer instructions' },
  subCommands: {
    eject: defineCommand({
      meta: { name: 'eject', description: 'Copy the built-in review pack for customization' },
      args: {
        repo: {
          type: 'boolean',
          description: 'Write to .amagi/review in the current repository',
          default: false,
        },
        force: {
          type: 'boolean',
          description: 'Overwrite existing built-in pack files',
          default: false,
        },
      },
      run({ args }) {
        const target = ejectReviewPack({
          repoRoot: repoRoot(),
          repo: Boolean(args.repo),
          force: Boolean(args.force),
        })
        console.log(`review pack copied to ${target}`)
      },
    }),
  },
})
