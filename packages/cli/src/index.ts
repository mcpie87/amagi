#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { askCommand } from './commands/ask.ts'
import { checkPrsCommand } from './commands/check-prs.ts'
import { cleanCommand } from './commands/clean.ts'
import { configCommand } from './commands/config.ts'
import { newCommand } from './commands/new.ts'
import { respondToMentionsCommand } from './commands/respond-to-mentions.ts'
import { runCommand } from './commands/run.ts'
import { serveCommand } from './commands/serve.ts'
import { statusCommand } from './commands/status.ts'
import { tuiCommand } from './commands/tui.ts'

const main = defineCommand({
  meta: {
    name: 'amagi',
    description: 'Orchestrates AI coding agents over an issue tracker',
  },
  subCommands: {
    run: runCommand,
    new: newCommand,
    status: statusCommand,
    config: configCommand,
    clean: cleanCommand,
    ask: askCommand,
    serve: serveCommand,
    tui: tuiCommand,
    'check-prs': checkPrsCommand,
    'respond-to-mentions': respondToMentionsCommand,
  },
})

runMain(main)
