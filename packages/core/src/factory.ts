import type { Config } from './config.ts'
import { ClaudeHarness } from './drivers/harness/claude.ts'
import { CodexHarness } from './drivers/harness/codex.ts'
import { OpencodeHarness } from './drivers/harness/opencode.ts'
import { BeadsTracker } from './drivers/tracker/beads.ts'
import { ForgejoTracker, GithubTracker } from './drivers/tracker/forge.ts'
import type { AgentStartOptions, Harness, Tracker } from './drivers/types.ts'

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

export function makeHarness(config: Config['harness']['implement']): Harness {
  switch (config.kind) {
    case 'claude':
      return new ClaudeHarness({ bin: config.bin })
    case 'opencode':
      return new OpencodeHarness({ bin: config.bin })
    case 'codex':
      return new CodexHarness({ bin: config.bin })
    default:
      throw new NotImplementedDriverError('harness', config.kind)
  }
}

/**
 * Maps the option fields of a harness config onto their AgentStartOptions
 * counterparts, dropping model/effort when unset. Shared by every
 * harness.start() call site so the spread stays in one place.
 */
export function harnessStartOpts(
  cfg: Pick<
    Config['harness']['implement'],
    'model' | 'effort' | 'permissions' | 'allowedTools' | 'extraArgs'
  >,
): Pick<AgentStartOptions, 'model' | 'effort' | 'permissions' | 'allowedTools' | 'extraArgs'> {
  return {
    model: cfg.model,
    effort: cfg.effort,
    ...(cfg.allowedTools === undefined ? {} : { allowedTools: cfg.allowedTools }),
    permissions: cfg.permissions,
    extraArgs: cfg.extraArgs,
  }
}
