import { mkdirSync } from 'node:fs'
import { loadConfig } from './config.ts'
import { forgeHost, forgeToken, parseRemote, resolveForgeRemote } from './drivers/forge-cred.ts'
import { makePrDriver } from './drivers/pr.ts'
import { errMsg } from './errors.ts'
import { exec, execOk } from './exec.ts'
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
 * Static readiness checks for a registered repo: git root resolves, config
 * parses, tracker and forge drivers are implemented and their CLIs are on
 * PATH, and the worktree root can be created. Everything here runs without
 * constructing the workspace, so onboarding never needs a server restart.
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
    const loaded = loadConfig(entry.path)
    config = loaded.config
    checks.push({ name: 'config', ok: true, detail: loaded.sources.join(', ') || 'defaults' })
  } catch (err) {
    return [...checks, { name: 'config', ok: false, detail: errMsg(err) }]
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
    const remote = await resolveForgeRemote(
      exec,
      entry.path,
      config.forge.kind,
      config.forge.remote,
    )
    const remoteUrl = await execOk(exec, ['git', 'remote', 'get-url', remote], {
      cwd: entry.path,
    }).catch(() => '')
    const host = parseRemote(remoteUrl.trim())?.base
    const matches =
      host !== undefined && new URL(host).host.toLowerCase() === forgeHost(config.forge.kind)
    checks.push({
      name: 'forge remote',
      ok: matches,
      detail: matches
        ? `${remote} (${new URL(host).host})`
        : `${remote} does not match ${forgeHost(config.forge.kind)}`,
    })
  } catch (err) {
    checks.push({ name: 'forge remote', ok: false, detail: errMsg(err) })
  }

  try {
    makePrDriver(config.forge.kind, undefined, config.forge.remote)
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
  } catch (err) {
    checks.push({
      name: `forge ${config.forge.kind}`,
      ok: false,
      detail: errMsg(err),
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

  const { commands, format, lint } = config.checks
  const gate = [format, lint].filter((c): c is string => c !== null && c !== '')
  const total = commands.length + gate.length
  checks.push({
    name: 'checks',
    ok: total > 0,
    detail: total === 0 ? 'none configured' : `${total} step(s)`,
  })

  return checks
}
