import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import * as z from 'zod'
import { cacheHome, expandTilde, globalConfigPath, repoConfigPath } from './paths.ts'

export const TrackerKind = z.enum(['beads', 'github', 'forgejo'])
export const HarnessKind = z.enum(['claude', 'codex', 'opencode'])
export const ForgeKind = z.enum(['github', 'forgejo'])

const HarnessConfig = z.object({
  kind: HarnessKind,
  /** Command used to invoke the harness. Defaults to the harness name. */
  bin: z.string().min(1).optional(),
  model: z.string().optional(),
  /** Reasoning effort (e.g. low/medium/high/xhigh for claude), passed through. */
  effort: z.string().optional(),
  /**
   * Least blast radius that still lets an unattended agent work. Raising this
   * to 'bypass' disables the harness permission system entirely; a worktree is
   * isolation, not a sandbox.
   */
  permissions: z.enum(['workspace-write', 'bypass']).default('workspace-write'),
  extraArgs: z.array(z.string()).default([]),
})

export const Config = z.object({
  repo: z
    .object({
      baseBranch: z.string().default('main'),
      worktreeRoot: z.string().default(join(cacheHome(), 'amagi', 'worktrees')),
      setupCmd: z.string().nullable().default(null),
      /**
       * Git persona applied to fresh worktrees: the name of a gitconfig
       * fragment under ~/.config/git/personas/<name>.gitconfig, included via
       * the worktree's own config so commits and PRs carry that identity.
       */
      persona: z.string().nullable().default(null),
    })
    .prefault({}),
  tracker: z.object({ kind: TrackerKind.default('beads') }).prefault({}),
  forge: z
    .object({
      kind: ForgeKind.default('github'),
      remote: z.string().default('origin'),
      /** Forge handle (without the @) the agent is pinged under on PRs; mentions of it trigger responses. */
      agentHandle: z.string().default('chise-maru'),
    })
    .prefault({}),
  harness: z
    .object({
      implement: HarnessConfig.prefault({ kind: 'claude' }),
      review: HarnessConfig.prefault({ kind: 'codex' }),
    })
    .prefault({}),
  loop: z
    .object({
      maxParallel: z.number().int().min(1).default(1),
      maxReviewRounds: z.number().int().min(0).default(3),
      /** Extra attempts handed back to the implementer when project checks fail. */
      maxCheckRounds: z.number().int().min(0).default(2),
      /** Kept under the 600s Bash timeout the harnesses impose on `amagi ask`. */
      questionTimeoutSec: z.number().int().min(10).default(540),
      /** How long the runner waits for an answer once the agent parks on a question. */
      questionParkTimeoutSec: z.number().int().min(1).default(3600),
      /**
       * Retries for transient harness failures (quota, rate limit, overloaded
       * model, flaky network). Backoff starts at retryBaseMs and doubles per
       * attempt, capped at retryMaxMs; the task escalates once maxRetries is
       * spent.
       */
      maxRetries: z.number().int().min(0).default(3),
      retryBaseMs: z.number().int().min(0).default(10_000),
      retryMaxMs: z.number().int().min(0).default(300_000),
    })
    .prefault({}),
  checks: z.object({ commands: z.array(z.string()).default([]) }).prefault({}),
  notify: z
    .object({
      desktop: z.boolean().default(true),
      ntfyTopic: z.string().nullable().default(null),
      ntfyServer: z.string().default('https://ntfy.sh'),
    })
    .prefault({}),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7777),
    })
    .prefault({}),
})
export type Config = z.infer<typeof Config>

type Json = Record<string, unknown>

const isPlainObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Later sources win. Arrays are replaced wholesale, never concatenated. */
function deepMerge(base: Json, overlay: Json): Json {
  const out: Json = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const prev = out[k]
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMerge(prev, v) : v
  }
  return out
}

function readToml(path: string): Json {
  if (!existsSync(path)) return {}
  const parsed = parseToml(readFileSync(path, 'utf8'))
  if (!isPlainObject(parsed)) throw new Error(`${path}: top level must be a table`)
  return parsed
}

export type LoadedConfig = {
  config: Config
  sources: string[]
}

export function loadConfig(repoRoot: string): LoadedConfig {
  const candidates = [globalConfigPath(), repoConfigPath(repoRoot)]
  const sources = candidates.filter((p) => existsSync(p))
  const merged = candidates.reduce<Json>((acc, p) => deepMerge(acc, readToml(p)), {})

  const parsed = Config.safeParse(merged)
  if (!parsed.success) {
    const where = sources.length ? sources.join(', ') : '<defaults>'
    throw new Error(`invalid amagi config (${where}):\n${z.prettifyError(parsed.error)}`)
  }

  const config = parsed.data
  config.repo.worktreeRoot = expandTilde(config.repo.worktreeRoot)
  return { config, sources }
}
