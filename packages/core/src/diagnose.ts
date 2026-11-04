import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import {
  type Config,
  loadConfig,
  resolveWorkerHarness,
  reviewerHarnessConfig,
  reviewerWorkerConfig,
  watcherHarnessConfig,
} from './config.ts'
import { forgeJson, resolveForge } from './drivers/forge-api.ts'
import { forgeHostname, gitRemoteUrls, remoteHostname } from './drivers/forge-cred.ts'
import { makePrDriver } from './drivers/pr.ts'
import { errMsg } from './errors.ts'
import { configuredCheckCommands } from './mandatory-checks.ts'
import { expandTilde } from './paths.ts'
import { isRepoRoot, type RegistryEntry } from './registry.ts'

/** `advisory` marks a check whose failure is shown but does not stop the repo claiming tasks. */
export type Diagnostic = { name: string; ok: boolean; detail?: string; advisory?: true }

/** How long a successful forge probe answers without another request. */
const PROBE_TTL_MS = 5 * 60_000
/** When each forge API root and token pair last answered the probe. */
const probedAt = new Map<string, number>()

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
 * Authenticated `GET user` against the forge the repo resolves to, so a token
 * passes only when the forge accepts it. A missing token or remote fails with
 * the resolver's error. Successes are cached per API root and token, since
 * /api/repos re-runs the diagnosis on every request; failures are not, so a
 * fixed token shows up at the next check.
 */
async function forgeAuthCheck(
  name: string,
  kind: Config['forge']['kind'],
  root: string,
  remote: string,
): Promise<Diagnostic> {
  try {
    const forge = await resolveForge(kind, root, remote)
    const key = `${forge.apiRoot}\n${createHash('sha256').update(forge.token).digest('hex')}`
    const last = probedAt.get(key)
    if (last === undefined || Date.now() - last >= PROBE_TTL_MS) {
      await forgeJson(forge, 'GET', 'user')
      probedAt.set(key, Date.now())
    }
    return { name, ok: true, detail: forge.base }
  } catch (err) {
    return { name, ok: false, detail: errMsg(err) }
  }
}

/**
 * One check per distinct harness binary this repo can spawn: harness.implement,
 * every enabled fleet worker, the enabled agent watchers and the reviewer. A
 * binary no implement worker or reviewer runs on is advisory: a claimed task
 * never spawns it, so its absence must not stop claims.
 * Resolution mirrors the spawn: Bun.spawn with no shell, so an alias or shell
 * function the operator's shell knows about is not a harness amagi can run.
 */
function harnessChecks(config: Config): Diagnostic[] {
  const uses: { user: string; harness: Config['harness']['implement']; runs: boolean }[] = [
    { user: 'harness.implement', harness: config.harness.implement, runs: false },
    ...config.worker
      .filter((worker) => worker.enabled)
      .map((worker) => ({
        user: `worker ${worker.name}`,
        harness: resolveWorkerHarness(config, worker),
        runs:
          worker.roles.includes('implement') ||
          (config.review.enabled && worker.roles.includes('review')),
      })),
    ...(['mention', 'prConflict'] as const)
      .filter((watcher) => config.watchers[watcher].enabled)
      .map((watcher) => ({
        user: `${watcher} watcher`,
        harness: watcherHarnessConfig(config, watcher),
        runs: false,
      })),
  ]
  if (config.review.enabled && reviewerWorkerConfig(config) === undefined) {
    try {
      uses.push({ user: 'review', harness: reviewerHarnessConfig(config), runs: true })
    } catch {
      // the config schema already rejects review.enabled with no reviewer harness
    }
  }

  const byBin = new Map<string, { users: string[]; runs: boolean }>()
  for (const { user, harness, runs } of uses) {
    const bin = [harness.bin ?? harness.kind].flat()[0] ?? harness.kind
    const seen = byBin.get(bin)
    byBin.set(bin, { users: [...(seen?.users ?? []), user], runs: runs || (seen?.runs ?? false) })
  }
  return [...byBin].map(([bin, { users, runs }]) => {
    const name = `harness ${bin}`
    const found = Bun.which(bin)
    if (found !== null) return { name, ok: true, detail: found }
    return {
      name,
      ok: false,
      detail: `${bin} not on PATH (used by ${users.join(', ')}); shell aliases and functions are not visible, point bin at an executable or an argv list starting with one`,
      ...(runs ? {} : { advisory: true as const }),
    }
  })
}

/**
 * Static readiness checks for a registered repo: git root resolves, config
 * parses, the beads CLI is on PATH or the forge accepts its token, the forge
 * driver is implemented, every harness binary resolves, the Linux sandbox
 * tools are on PATH, and the worktree root can be created. Everything here
 * runs without constructing the workspace, so onboarding never needs a server
 * restart.
 */
export async function diagnoseRepo(entry: RegistryEntry): Promise<Diagnostic[]> {
  const checks: Diagnostic[] = []

  if (!isRepoRoot(entry.path)) {
    return [
      { name: 'git root', ok: false, detail: `${entry.path} is not inside a git working tree` },
    ]
  }
  checks.push({ name: 'git root', ok: true })

  let config: Awaited<ReturnType<typeof loadConfig>>['config']
  try {
    const loaded = loadConfig(entry.path, { allowIncompleteChecks: true })
    config = loaded.config
    try {
      loadConfig(entry.path)
      checks.push({ name: 'config', ok: true, detail: loaded.sources.join(', ') || 'defaults' })
    } catch (err) {
      checks.push({ name: 'config', ok: false, detail: errMsg(err) })
    }
  } catch (err) {
    return [...checks, { name: 'config', ok: false, detail: errMsg(err) }]
  }

  if (config.tracker.kind === 'beads') {
    const found = binaryExists('bd')
    checks.push({
      name: 'tracker beads',
      ok: found,
      ...(found ? {} : { detail: 'bd not on PATH' }),
    })
  } else {
    checks.push(
      await forgeAuthCheck(
        `tracker ${config.tracker.kind}`,
        config.tracker.kind,
        entry.path,
        config.forge.remote,
      ),
    )
  }

  try {
    makePrDriver(config.forge.kind, config.forge.remote)
    checks.push(
      await forgeAuthCheck(
        `forge ${config.forge.kind} token`,
        config.forge.kind,
        entry.path,
        config.forge.remote,
      ),
    )
    checks.push(forgeRemoteCheck(entry.path, config.forge.kind, config.forge.remote))
  } catch (err) {
    checks.push({
      name: `forge ${config.forge.kind}`,
      ok: false,
      detail: errMsg(err),
    })
  }

  checks.push(...harnessChecks(config))

  if (process.platform === 'linux') {
    const missing = ['bwrap', 'pasta'].filter(
      (bin) => Bun.which(bin, { PATH: process.env.PATH ?? '' }) === null,
    )
    checks.push({
      name: 'sandbox',
      ok: missing.length === 0,
      ...(missing.length === 0
        ? {}
        : {
            detail: `${missing.join(', ')} not on the server's PATH; agents need bwrap, setup and checks need pasta (from passt)`,
          }),
    })
  }

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

  checks.push({
    name: 'checks',
    ok: checks.find((check) => check.name === 'config')?.ok === true,
    detail:
      configuredCheckCommands(config.checks).length === 0
        ? 'No project checks configured'
        : `${configuredCheckCommands(config.checks).length} step(s)`,
  })

  return checks
}
