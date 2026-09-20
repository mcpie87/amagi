import type { Config } from './config.ts'
import { ClaudeHarness } from './drivers/harness/claude.ts'
import { BeadsTracker } from './drivers/tracker/beads.ts'
import type { Harness, Tracker } from './drivers/types.ts'

export class NotImplementedDriverError extends Error {
  constructor(role: string, kind: string) {
    super(`${role} driver "${kind}" is configured but not implemented yet`)
    this.name = 'NotImplementedDriverError'
  }
}

export function makeTracker(config: Config, repoRoot: string, actor = 'amagi'): Tracker {
  switch (config.tracker.kind) {
    case 'beads':
      return new BeadsTracker({ cwd: repoRoot, actor })
    default:
      throw new NotImplementedDriverError('tracker', config.tracker.kind)
  }
}

export function makeHarness(kind: string): Harness {
  switch (kind) {
    case 'claude':
      return new ClaudeHarness()
    default:
      throw new NotImplementedDriverError('harness', kind)
  }
}
