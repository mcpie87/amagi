#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty'
import { addCommand } from './commands/add.ts'
import { answerCommand } from './commands/answer.ts'
import { askCommand } from './commands/ask.ts'
import { checkPrsCommand } from './commands/check-prs.ts'
import { cleanCommand } from './commands/clean.ts'
import { configCommand } from './commands/config.ts'
import { continueCommand } from './commands/continue.ts'
import { gitRequestCommand } from './commands/git-request.ts'
import { mergeablePrsCommand } from './commands/mergeable-prs.ts'
import { newCommand } from './commands/new.ts'
import { removeCommand } from './commands/remove.ts'
import { reposCommand } from './commands/repos.ts'
import { respondToMentionsCommand } from './commands/respond-to-mentions.ts'
import { runCommand } from './commands/run.ts'
import { serveCommand } from './commands/serve.ts'
import { statusCommand } from './commands/status.ts'
import { stopCommand } from './commands/stop.ts'
import { triageCommand } from './commands/triage.ts'
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
    triage: triageCommand,
    config: configCommand,
    clean: cleanCommand,
    ask: askCommand,
    answer: answerCommand,
    'git-request': gitRequestCommand,
    serve: serveCommand,
    tui: tuiCommand,
    stop: stopCommand,
    continue: continueCommand,
    repos: reposCommand,
    add: addCommand,
    remove: removeCommand,
    'check-prs': checkPrsCommand,
    'mergeable-prs': mergeablePrsCommand,
    'respond-to-mentions': respondToMentionsCommand,
  },
})

runMain(main)
