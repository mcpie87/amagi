import type { Config } from './config.ts'
import { ClaudeHarness } from './drivers/harness/claude.ts'
import { OpencodeHarness } from './drivers/harness/opencode.ts'
import { BeadsTracker } from './drivers/tracker/beads.ts'
import { ForgejoTracker, GithubTracker } from './drivers/tracker/forge.ts'
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
    case 'github':
      return new GithubTracker({ cwd: repoRoot })
    case 'forgejo':
      return new ForgejoTracker({ cwd: repoRoot })
    default:
      throw new NotImplementedDriverError('tracker', config.tracker.kind)
  }
}

export function makeHarness(kind: string): Harness {
  switch (kind) {
    case 'claude':
      return new ClaudeHarness()
    case 'opencode':
      return new OpencodeHarness()
    default:
      throw new NotImplementedDriverError('harness', kind)
  }
}
