#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { configCommand } from './commands/config.ts'
import { statusCommand } from './commands/status.ts'

const main = defineCommand({
  meta: {
    name: 'amagi',
    description: 'Orchestrates AI coding agents over an issue tracker',
  },
  subCommands: {
    status: statusCommand,
    config: configCommand,
  },
})

runMain(main)
