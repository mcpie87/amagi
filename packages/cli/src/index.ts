#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { askCommand } from './commands/ask.ts'
import { checkPrsCommand } from './commands/check-prs.ts'
import { cleanCommand } from './commands/clean.ts'
import { configCommand } from './commands/config.ts'
import { runCommand } from './commands/run.ts'
import { serveCommand } from './commands/serve.ts'
import { statusCommand } from './commands/status.ts'

const main = defineCommand({
  meta: {
    name: 'amagi',
    description: 'Orchestrates AI coding agents over an issue tracker',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
    config: configCommand,
    clean: cleanCommand,
    ask: askCommand,
    serve: serveCommand,
    'check-prs': checkPrsCommand,
  },
})

runMain(main)
