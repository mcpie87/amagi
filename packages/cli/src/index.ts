#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { addCommand } from './commands/add.ts'
import { askCommand } from './commands/ask.ts'
import { checkPrsCommand } from './commands/check-prs.ts'
import { cleanCommand } from './commands/clean.ts'
import { configCommand } from './commands/config.ts'
import { continueCommand } from './commands/continue.ts'
import { removeCommand } from './commands/remove.ts'
import { reposCommand } from './commands/repos.ts'
import { respondToMentionsCommand } from './commands/respond-to-mentions.ts'
import { runCommand } from './commands/run.ts'
import { serveCommand } from './commands/serve.ts'
import { statusCommand } from './commands/status.ts'
import { triageCommand } from './commands/triage.ts'
import { stopCommand } from './commands/stop.ts'
import { tuiCommand } from './commands/tui.ts'

const main = defineCommand({
  meta: {
    name: 'amagi',
    description: 'Orchestrates AI coding agents over an issue tracker',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
    triage: triageCommand,
    config: configCommand,
    clean: cleanCommand,
    ask: askCommand,
    serve: serveCommand,
    tui: tuiCommand,
    stop: stopCommand,
    continue: continueCommand,
    repos: reposCommand,
    add: addCommand,
    remove: removeCommand,
    'check-prs': checkPrsCommand,
    'respond-to-mentions': respondToMentionsCommand,
  },
})

runMain(main)
