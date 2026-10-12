import { mkdirSync } from 'node:fs'
import {
  type Config,
  loadConfig,
  resolveWorkerHarness,
  reviewerHarnessConfig,
  reviewerWorkerConfig,
  watcherHarnessConfig,
} from './config.ts'
import { forgeHostname, forgeToken, gitRemoteUrls, remoteHostname } from './drivers/forge-cred.ts'
import { makePrDriver } from './drivers/pr.ts'
import { errMsg } from './errors.ts'
import { expandTilde } from './paths.ts'
import { isRepoRoot, type RegistryEntry } from './registry.ts'

export type Diagnostic = { name: string; ok: boolean; detail?: string }

const TRACKER_BIN: Record<string, string> = { beads: 'bd', github: 'gh', forgejo: 'tea' }
const FORGE_BIN: Record<string, string> = { github: 'gh', gitlab: 'glab', forgejo: 'tea' }
/** Env var a forge token comes from, per kind, so the diagnostic names the fix. */
const FORGE_TOKEN_VAR: Record<string, string> = {
  github: 'GH_TOKEN or GITHUB_TOKEN',
  gitlab: 'GITLAB_TOKEN',
  forgejo: 'FORGEJO_TOKEN',
}

function binaryExists(bin: string): boolean {
  const r = Bun.spawnSync(['which', bin], { stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0
}

/**
 * The forge remote exists and points at the selected forge, so a push never
 * carries one forge's token to another. Passes when the forge host is unknown.
 */
function forgeRemoteCheck(root: string, kind: Config['forge']['kind'], remote: string): Diagnostic {
  const name = 'forge remote'
  const url = gitRemoteUrls(root).find((r) => r.name === remote)?.url
  if (url === undefined) return { name, ok: false, detail: `no git remote named ${remote}` }
  const want = forgeHostname(kind, root)
  const got = remoteHostname(url)
  if (want !== null && got !== want) {
    return {
      name,
      ok: false,
      detail: `${remote} points at ${got ?? url}, not the ${kind} forge at ${want}`,
    }
  }
  return { name, ok: true, detail: `${remote} (${url})` }
}

/**
 * One check per distinct harness binary this repo can spawn: harness.implement,
 * every enabled fleet worker, the enabled agent watchers and the reviewer.
 * Resolution mirrors the spawn: Bun.spawn with no shell, so an alias or shell
 * function the operator's shell knows about is not a harness amagi can run.
 */
function harnessChecks(config: Config): Diagnostic[] {
  const uses: { user: string; harness: Config['harness']['implement'] }[] = [
    { user: 'harness.implement', harness: config.harness.implement },
    ...config.worker
      .filter((worker) => worker.enabled)
      .map((worker) => ({
        user: `worker ${worker.name}`,
        harness: resolveWorkerHarness(config, worker),
      })),
    ...(['mention', 'prConflict'] as const)
      .filter((watcher) => config.watchers[watcher].enabled)
      .map((watcher) => ({
        user: `${watcher} watcher`,
        harness: watcherHarnessConfig(config, watcher),
      })),
  ]
  if (config.review.enabled && reviewerWorkerConfig(config) === undefined) {
    try {
      uses.push({ user: 'review', harness: reviewerHarnessConfig(config) })
    } catch {
      // the config schema already rejects review.enabled with no reviewer harness
    }
  }

  const usersByBin = new Map<string, string[]>()
  for (const { user, harness } of uses) {
    const bin = harness.bin ?? harness.kind
    usersByBin.set(bin, [...(usersByBin.get(bin) ?? []), user])
  }
  return [...usersByBin].map(([bin, users]) => {
    const name = `harness ${bin}`
    const found = Bun.which(bin)
    if (found !== null) return { name, ok: true, detail: found }
    return {
      name,
      ok: false,
      detail: `${bin} not on PATH (used by ${users.join(', ')}); shell aliases and functions are not visible, point bin at an executable`,
    }
  })
}

/**
 * Static readiness checks for a registered repo: git root resolves, config
 * parses, tracker and forge drivers are implemented and their CLIs are on
 * PATH, every harness binary resolves, and the worktree root can be created. Everything here runs without
 * constructing the workspace, so onboarding never needs a server restart.
 */
export function diagnoseRepo(entry: RegistryEntry): Promise<Diagnostic[]> {
  const checks: Diagnostic[] = []

  if (!isRepoRoot(entry.path)) {
    return Promise.resolve([
      { name: 'git root', ok: false, detail: `${entry.path} is not inside a git working tree` },
    ])
  }
  checks.push({ name: 'git root', ok: true })

  let config: Awaited<ReturnType<typeof loadConfig>>['config']
  try {
    const loaded = loadConfig(entry.path)
    config = loaded.config
    checks.push({ name: 'config', ok: true, detail: loaded.sources.join(', ') || 'defaults' })
  } catch (err) {
    return Promise.resolve([...checks, { name: 'config', ok: false, detail: errMsg(err) }])
  }

  const trackerBin = TRACKER_BIN[config.tracker.kind]
  if (trackerBin === undefined) {
    checks.push({
      name: `tracker ${config.tracker.kind}`,
      ok: false,
      detail: 'driver not implemented',
    })
  } else {
    checks.push({
      name: `tracker ${config.tracker.kind}`,
      ok: binaryExists(trackerBin),
      ...(binaryExists(trackerBin) ? {} : { detail: `${trackerBin} not on PATH` }),
    })
  }

  try {
    makePrDriver(config.forge.kind, config.forge.remote)
    const forgeBin = FORGE_BIN[config.forge.kind]
    checks.push({
      name: `forge ${config.forge.kind}`,
      ok: forgeBin !== undefined && binaryExists(forgeBin),
      ...(forgeBin === undefined
        ? { detail: 'driver not implemented' }
        : binaryExists(forgeBin)
          ? {}
          : { detail: `${forgeBin} not on PATH` }),
    })
    checks.push({
      name: `forge ${config.forge.kind} token`,
      ok: forgeToken(config.forge.kind, entry.path) !== null,
      ...(forgeToken(config.forge.kind, entry.path) === null
        ? {
            detail: `no dashboard forge token for this repository and ${FORGE_TOKEN_VAR[config.forge.kind] ?? 'no token env var'} not set`,
          }
        : {}),
    })
    checks.push(forgeRemoteCheck(entry.path, config.forge.kind, config.forge.remote))
  } catch (err) {
    checks.push({
      name: `forge ${config.forge.kind}`,
      ok: false,
      detail: errMsg(err),
    })
  }

  checks.push(...harnessChecks(config))

  const worktreeRoot = expandTilde(config.repo.worktreeRoot)
  try {
    mkdirSync(worktreeRoot, { recursive: true })
    checks.push({ name: 'worktree root', ok: true, detail: worktreeRoot })
  } catch (err) {
    checks.push({
      name: 'worktree root',
      ok: false,
      detail: `${worktreeRoot}: ${errMsg(err)}`,
    })
  }

  const { commands, format, lint, test } = config.checks
  const gate = [format, lint, test].filter((c): c is string => c !== null && c !== '')
  const total = commands.length + gate.length
  checks.push({
    name: 'checks',
    ok: total > 0,
    detail: total === 0 ? 'none configured' : `${total} step(s)`,
  })

  return Promise.resolve(checks)
}
