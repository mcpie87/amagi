import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stateHome } from '../../paths.ts'
import { prepareShim } from './shim.ts'

const FORGE_CREDENTIAL =
  /^(GH_TOKEN|GITHUB_TOKEN|FORGEJO_TOKEN|GITEA_SERVER_(TOKEN|USER|PASSWORD|OTP)|TEA_TOKEN)$/

/** gh/tea config dirs whose contents are forge credentials and must never reach an agent. */
const FORGE_CONFIG_DIRS = ['gh', 'tea']

/** Amagi-owned XDG_CONFIG_HOME for harness agents: the operator's config minus forge login dirs. */
function agentXdgHome(): string {
  return join(stateHome(), 'amagi', 'forge', 'agents', 'xdg')
}

/**
 * Prepares the agent-scoped XDG_CONFIG_HOME once: a symlink farm over the
 * operator's real config home, except the gh and tea directories, so harness
 * agents keep their own tooling config but can never read a stored forge
 * login. A real config home that disappears later is harmless, the empty
 * agent dir still fails closed.
 */
function prepareAgentXdg(): string {
  const agent = agentXdgHome()
  mkdirSync(agent, { recursive: true })
  const real = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  if (real === agent) return agent
  try {
    for (const entry of readdirSync(real, { withFileTypes: true })) {
      if (FORGE_CONFIG_DIRS.includes(entry.name)) continue
      const link = join(agent, entry.name)
      if (!existsSync(link)) symlinkSync(join(real, entry.name), link)
    }
  } catch {
    // no real config home (or it vanished): the empty agent dir is the point
  }
  return agent
}

/**
 * Env for a harness agent. Forge tokens never reach the process, and gh/tea
 * are pointed at Amagi-owned dirs with no credentials so the agent cannot
 * inherit the operator's or the bot's stored forge login. The shim dir is
 * prepended to PATH so every git/amagi the agent runs through PATH hits the
 * read-only gate, in every harness and every phase. This is defense-in-depth,
 * not an enforcement boundary: an agent that uses absolute paths or rewrites
 * its own PATH reaches the real binaries.
 */
export function harnessEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !FORGE_CREDENTIAL.test(name)),
  ) as Record<string, string>

  const ghDir = join(stateHome(), 'amagi', 'forge', 'agents', 'gh')
  mkdirSync(ghDir, { recursive: true })
  env.GH_CONFIG_DIR = ghDir
  env.XDG_CONFIG_HOME = prepareAgentXdg()
  const shim = prepareShim()
  env.PATH = env.PATH ? `${shim}:${env.PATH}` : shim
  return env
}
