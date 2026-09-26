import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import * as z from 'zod'
import { FindingSeverity, findingSeverityAtOrAbove } from './events.ts'
import { MAX_WORKERS } from './limits.ts'
import { cacheHome, expandTilde, globalConfigPath, repoConfigPath } from './paths.ts'

export const TrackerKind = z.enum(['beads', 'github', 'forgejo'])
export const HarnessKind = z.enum(['claude', 'codex', 'opencode'])
export const ForgeKind = z.enum(['github', 'forgejo'])

export const DifficultyConfig = z.object({
  /**
   * Master switch: when off, no LLM pass runs at task creation and no claim is
   * gated. Defaults off so the feature is opt-in.
   */
  enabled: z.boolean().default(false),
  /** Difficulty levels a task can be classified into, easiest first. */
  levels: z.array(z.string().min(1)).default(['low', 'medium', 'high']),
  /** Model tiers, weakest first; a model's tier is its index in this list. */
  tierOrder: z.array(z.string().min(1)).default(['fast', 'smart']),
  /** The minimum tier a task of a given difficulty needs; unlisted levels require the weakest tier. */
  requiredTier: z.record(z.string(), z.string()).default({ high: 'smart' }),
  /** Explicit model id -> tier mapping; an unlisted model counts as the weakest tier. */
  modelTiers: z.record(z.string(), z.string()).default({}),
})

export const HarnessConfig = z.object({
  kind: HarnessKind,
  /** Credential seat shared by every process using this subscription. */
  seat: z.string().min(1).optional(),
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
  /**
   * Tool allowlist handed to the harness (claude) in place of the default.
   * Leave unset to use the harness's own default set.
   */
  allowedTools: z.array(z.string()).optional(),
  extraArgs: z.array(z.string()).default([]),
})

export const ReviewConfig = z.object({
  enabled: z.boolean().default(false),
  harness: HarnessConfig.optional(),
  maxRounds: z.number().int().min(1).default(3),
  threshold: FindingSeverity.default('major'),
  finalPass: z.boolean().default(false),
  maxTokens: z.number().int().min(0).default(2_000_000),
  lenses: z.array(z.string().min(1)).default([]),
})

export { findingSeverityAtOrAbove as severityAtOrAbove }

const WatcherHarnessConfig = z.object({
  kind: HarnessKind.optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  seat: z.string().min(1).optional(),
})

/**
 * A named lane in the fleet. `id` is the identity (locks and run history key
 * on it); `name` is a free-text label that may be renamed or duplicated.
 */
export const WorkerConfig = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  kind: HarnessKind,
  model: z.string().optional(),
  effort: z.string().optional(),
  seat: z.string().min(1).optional(),
  enabled: z.boolean().default(false),
})
export type WorkerConfig = z.infer<typeof WorkerConfig>

/** Resolves a harness kind while preserving repo-specific settings for the configured implement kind. */
export function resolveHarnessKind(
  config: Config,
  kind: WorkerConfig['kind'],
): Config['harness']['implement'] {
  return kind === config.harness.implement.kind
    ? config.harness.implement
    : HarnessConfig.parse({ kind })
}

/** Resolves a worker profile for one run without changing the stored fleet. */
export function resolveWorkerHarness(
  config: Config,
  worker: WorkerConfig,
  overrides: { kind?: WorkerConfig['kind']; model?: string; effort?: string } = {},
): Config['harness']['implement'] {
  const kind = overrides.kind ?? worker.kind
  const base = resolveHarnessKind(config, kind)
  return {
    ...base,
    model: overrides.model ?? worker.model ?? base.model,
    effort: overrides.effort ?? worker.effort ?? base.effort,
    seat: worker.seat ?? worker.kind,
  }
}

const AgentWatcherConfig = z.object({
  enabled: z.boolean().default(true),
  ...WatcherHarnessConfig.shape,
})

export const Config = z
  .object({
    /** The fleet: `[[worker]]` tables, global config only. */
    worker: z
      .array(WorkerConfig)
      .max(MAX_WORKERS)
      .default([])
      .refine((ws) => new Set(ws.map((w) => w.id)).size === ws.length, {
        message: 'worker ids must be unique',
      }),
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
        /**
         * Named harness definitions offered by the `amagi run` interactive
         * picker, e.g. `[harness.definitions.fast]`. Each is a full harness
         * config; the picker falls back to the three known kinds when empty.
         */
        definitions: z.record(z.string().min(1), HarnessConfig).default({}),
        implement: HarnessConfig.prefault({ kind: 'claude' }),
        review: HarnessConfig.prefault({ kind: 'codex' }),
        triage: HarnessConfig.prefault({ kind: 'claude' }),
      })
      .prefault({}),
    review: ReviewConfig.prefault({}),
    watchers: z
      .object({
        mention: AgentWatcherConfig.prefault({ enabled: true }),
        prConflict: AgentWatcherConfig.prefault({ enabled: true }),
        stall: z.object({ enabled: z.boolean().default(true) }).prefault({ enabled: true }),
      })
      .prefault({}),
    loop: z
      .object({
        /** Extra attempts handed back to the implementer when project checks fail. */
        maxCheckRounds: z.number().int().min(0).default(2),
        /**
         * How often the agent-mention watcher polls open PRs for comments and
         * reviews mentioning the agent handle. Defaults to 5 minutes: paired
         * with last-seen-per-PR tracking, unchanged PRs are not re-scanned, so
         * the default stays inside GitHub REST rate limits.
         */
        mentionWatchIntervalSec: z.number().int().min(1).default(300),
        /**
         * How often the PR conflict watcher scans open PRs and dispatches an
         * agent per conflicting one. Defaults to 5 minutes: ticks are
         * sequential (a long resolution delays the next check) and each PR is
         * only attempted once per head SHA, so the default stays inside GitHub
         * REST rate limits.
         */
        prCheckIntervalSec: z.number().int().min(1).default(300),
        /**
         * Max conflict-resolution agent dispatches per conflicting PR before the
         * conflict checker parks the linked task at needs_human. A PR that keeps
         * re-conflicting burns through its iterations and sinks in the dispatch
         * order instead of being re-dispatched forever.
         */
        conflictMaxIterations: z.number().int().min(1).default(3),
        /**
         * Observation-only merge-tree audit: each tick, compare the local
         * `git merge-tree` verdict against GitHub's `mergeable` for every open
         * PR and append the result to an observation JSONL under the cache dir.
         * Dispatch stays on GitHub's verdict, so this changes no behaviour.
         * Defaults off; the JSONL is the evidence for trusting either side.
         */
        mergeTreeCheck: z.boolean().default(false),
        /**
         * How often the stall watcher scans in-progress tasks for a worker that
         * stopped heartbeating. Defaults to 5 minutes; cheap, since it only
         * reads the local store and checks one timestamp per task.
         */
        stallWatchIntervalSec: z.number().int().min(1).default(300),
        /**
         * How long a task may sit in an in-progress state with no worker
         * heartbeat before the stall watcher reclaims it (release the tracker
         * claim and park it back to claimed, keeping the worktree). Default 1h.
         */
        stallTimeoutSec: z.number().int().min(60).default(3600),
        /**
         * Doom-loop guard: the stall watcher also scans busy workers for a
         * busy-but-not-progressing agent and stops the run. Set false to disable
         * while tuning the thresholds below for a repo.
         */
        doomEnabled: z.boolean().default(true),
        /** Repeated near-identical tool calls (same command or file) within this many seconds trip the guard. */
        doomToolWindowSec: z.number().int().min(1).default(600),
        /** How many near-identical tool calls within the window trip the guard. */
        doomToolRepeat: z.number().int().min(2).default(20),
        /** Consecutive check rounds sharing one failure signature that trip the guard. */
        doomCheckRounds: z.number().int().min(2).default(3),
        /** A live worker whose worktree diff has not changed for this many seconds trips the guard. */
        doomDiffWindowSec: z.number().int().min(60).default(1800),
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
        /**
         * Input context at which a run is flagged: the runner appends a
         * `context.warn` event once the run's peak context (the input, cached
         * tokens included, of its largest single model request) reaches it. Kept under `contextMaxTokens` so there is a
         * breathing room between warning and acting.
         */
        contextWarnTokens: z.number().int().min(0).default(160_000),
        /**
         * Input context at which a run is stopped: crossing it kills the current
         * agent process and restarts it with a fresh session instead of letting
         * the harness degrade. Defaults to the claude 200k window; harnesses with
         * a different window override it via `contextOverrides`.
         */
        contextMaxTokens: z.number().int().min(0).default(200_000),
        /**
         * How many fresh-context restarts a task gets after a run trips the hard
         * context limit, before escalating to needs_human. Each restart reuses
         * the worktree and claim and hands the new session a synthesized handoff
         * of what was done so far. 0 keeps the historical hard-kill behavior.
         */
        contextMaxRestarts: z.number().int().min(0).default(1),
        /**
         * Per-harness context budget overrides, keyed by harness kind
         * (claude/codex/opencode), since context windows differ between them.
         * Unset fields fall back to contextWarnTokens/contextMaxTokens.
         */
        contextOverrides: z
          .record(
            z.string(),
            z.object({
              warnTokens: z.number().int().min(0).optional(),
              maxTokens: z.number().int().min(0).optional(),
            }),
          )
          .default({}),
        /**
         * Automatic dispatch: while on, the runner polls for the next ready task
         * and launches it whenever a slot is free, instead of waiting for Run.
         */
        autoQueue: z.boolean().default(false),
        /**
         * How long the auto-queue waits between polls when nothing is claimable,
         * so an empty queue does not hammer the tracker.
         */
        autoQueueIdleSec: z.number().int().min(1).default(60),
        /**
         * Hard ceiling on how long a task may run, in minutes, counted from
         * first claim and spanning every round and reclaim. 0 disables the
         * wall-clock budget (the historical unbounded behavior).
         */
        maxRunMinutes: z.number().int().min(0).default(0),
        /**
         * Hard ceiling on how much a task may spend, in USD, accumulated from
         * usage cost across every round and reclaim. Harnesses that report no
         * cost (codex) skip the budget rather than treating cost as zero. 0
         * disables the cost budget.
         */
        maxCostUsd: z.number().min(0).default(0),
      })
      .prefault({}),
    checks: z
      .object({
        commands: z.array(z.string()).default([]),
        /**
         * Mandatory pre-commit gate, run before `commands`: the auto-fix formatter
         * (writes the worktree) and the read-only lint check. Null disables a
         * step; both default on so a PR can never be pushed unformatted.
         */
        format: z.string().nullable().default('just fmt'),
        lint: z.string().nullable().default('just lint'),
      })
      .prefault({}),
    difficulty: DifficultyConfig.prefault({}),
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
  .superRefine((config, ctx) => {
    if (
      config.review.enabled &&
      config.review.harness === undefined &&
      defaultReviewerKind(config.harness.implement.kind) === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['review', 'harness'],
        message: `review.enabled is true but no reviewer harness is configured or installed with a kind different from ${config.harness.implement.kind}`,
      })
    }
  })
export type Config = z.infer<typeof Config>

function harnessInstalled(kind: z.infer<typeof HarnessKind>): boolean {
  const path = process.env.PATH ?? ''
  return path.split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, kind), constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

function defaultReviewerKind(
  implementKind: z.infer<typeof HarnessKind>,
): z.infer<typeof HarnessKind> | undefined {
  return HarnessKind.options.find(
    (candidate) => candidate !== implementKind && harnessInstalled(candidate),
  )
}

/** Resolve the review harness, choosing an installed kind other than implement by default. */
export function reviewerHarnessConfig(config: Config): Config['harness']['implement'] {
  const configured = config.review.harness
  if (configured) return configured
  const kind = defaultReviewerKind(config.harness.implement.kind)
  if (!kind) {
    throw new Error(
      `review.enabled is true but no reviewer harness is configured or installed with a kind different from ${config.harness.implement.kind}`,
    )
  }
  return HarnessConfig.parse({ kind })
}

export type AgentWatcherKind = 'mention' | 'prConflict'

export function watcherHarnessConfig(
  config: Config,
  watcher: AgentWatcherKind,
): Config['harness']['implement'] {
  const { enabled: _enabled, ...overrides } = config.watchers[watcher]
  const implement = config.harness.implement
  // bin, model, extraArgs etc. belong to the implement harness; handing them to a different kind runs e.g. claude argv through a codex binary.
  const base =
    overrides.kind === undefined || overrides.kind === implement.kind
      ? implement
      : HarnessConfig.parse({ kind: overrides.kind, permissions: implement.permissions })
  return { ...base, ...overrides, kind: overrides.kind ?? implement.kind }
}

export const workerSeat = (worker: Pick<WorkerConfig, 'kind' | 'seat'>): string =>
  worker.seat ?? worker.kind

const HARNESS_LABEL: Record<z.infer<typeof HarnessKind>, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/** Short slug not already taken by `taken`; never derived from the name, so a rename cannot move it. */
export function newWorkerId(taken: Iterable<string>): string {
  const used = new Set(taken)
  for (;;) {
    const id = `w-${randomUUID().slice(0, 6)}`
    if (!used.has(id)) return id
  }
}

type Json = Record<string, unknown>

const isPlainObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Later sources win. Arrays are replaced wholesale, never concatenated. A null
 * in the overlay deletes the key: TOML has no null, so a patch uses it to clear
 * an optional setting back to its default.
 */
function deepMerge(base: Json, overlay: Json): Json {
  const out: Json = { ...base }
  for (const [k, v] of Object.entries(overlay)) {
    const prev = out[k]
    if (v === null) delete out[k]
    else out[k] = isPlainObject(v) ? deepMerge(isPlainObject(prev) ? prev : {}, v) : v
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

export function hasStaleMaxParallel(repoRoot: string): boolean {
  const paths = [globalConfigPath(), repoConfigPath(repoRoot)]
  return paths.some((path) => {
    const raw = readToml(path)
    return isPlainObject(raw.loop) && 'maxParallel' in raw.loop
  })
}

export function loadConfig(repoRoot: string): LoadedConfig {
  const candidates = [globalConfigPath(), repoConfigPath(repoRoot)]
  const sources = candidates.filter((p) => existsSync(p))
  const repoToml = readToml(repoConfigPath(repoRoot))
  if ('worker' in repoToml) {
    throw new Error(
      `${repoConfigPath(repoRoot)}: [[worker]] belongs in the global config (${globalConfigPath()}), not a repo config`,
    )
  }
  const merged = deepMerge(readToml(globalConfigPath()), repoToml)

  const parsed = Config.safeParse(merged)
  if (!parsed.success) {
    const where = sources.length ? sources.join(', ') : '<defaults>'
    throw new Error(`invalid amagi config (${where}):\n${z.prettifyError(parsed.error)}`)
  }

  const config = parsed.data
  config.repo.worktreeRoot = expandTilde(config.repo.worktreeRoot)
  return { config, sources }
}

/**
 * The server-wide settings (host, port) come from the global config alone,
 * because `serve` now hosts every registered repo, not just the cwd one.
 */
export function loadGlobalConfig(): Config {
  const path = globalConfigPath()
  const merged = existsSync(path) ? readToml(path) : {}
  const parsed = Config.safeParse(merged)
  if (!parsed.success) {
    throw new Error(`invalid amagi config (${path}):\n${z.prettifyError(parsed.error)}`)
  }
  const config = parsed.data
  config.repo.worktreeRoot = expandTilde(config.repo.worktreeRoot)
  return config
}

/**
 * One-time migration: with no `[[worker]]` tables in the global config,
 * synthesizes one worker from `harness.implement` and writes it there.
 * Returns the created worker, empty when a fleet already exists.
 */
export function migrateFleet(): WorkerConfig[] {
  if ('worker' in readToml(globalConfigPath())) return []
  const config = loadGlobalConfig()
  const { kind, model, effort, seat } = config.harness.implement
  const workers: WorkerConfig[] = [
    {
      id: newWorkerId([]),
      name: `${HARNESS_LABEL[kind]} 1`,
      kind,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      seat: seat ?? kind,
      enabled: true,
    },
  ]
  writeGlobalConfig({ worker: workers })
  return workers
}

/** Global-config twin of `writeConfig`; arrays in the patch (e.g. `worker`) replace wholesale, nulls delete. */
export function writeGlobalConfig(patch: Json): void {
  const path = globalConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyToml(deepMerge(readToml(path), patch)))
}

/**
 * Merges a patch into the repo's own `.amagi/config.toml` and writes it back,
 * preserving every other key. Creates the file (and directory) when absent.
 * `loadConfig` re-reads it on next use, so persisted settings survive restarts.
 */
export function writeConfig(repoRoot: string, patch: Json): void {
  const path = repoConfigPath(repoRoot)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, stringifyToml(deepMerge(readToml(path), patch)))
}
