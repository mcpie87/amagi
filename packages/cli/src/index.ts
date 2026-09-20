#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { askCommand } from './commands/ask.ts'
import { cleanCommand } from './commands/clean.ts'
import { configCommand } from './commands/config.ts'
import { hiCommand } from './commands/hi.ts'
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
    hi: hiCommand,
  },
})

runMain(main)
