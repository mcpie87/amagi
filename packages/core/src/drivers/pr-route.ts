import type { Config } from '../config.ts'
import { gitRemoteUrls, parseRemote } from './forge-cred.ts'
import { makePrDriver, type PrDriver } from './pr.ts'

type ForgeKind = Config['forge']['kind']

/** The forge a PR lives on: `config` carries that forge's kind and remote, `key` groups PRs by it. */
export type PrForge = { key: string; config: Config; driver: PrDriver }

/** Key of the configured forge; foreign forges are keyed `<kind>:<remote>`. */
export const PRIMARY_FORGE = ''

const PR_PATHS: readonly { kind: ForgeKind; re: RegExp }[] = [
  { kind: 'gitlab', re: /^\/(.+?)\/-\/merge_requests\/\d+/ },
  { kind: 'forgejo', re: /^\/(.+?)\/pulls\/\d+/ },
  { kind: 'github', re: /^\/(.+?)\/pull\/\d+/ },
]

/**
 * The forge kind and git remote a PR URL points at, matched against `remotes`
 * by hostname and owner/repo path. Null when the URL is not a PR link or no
 * remote hosts that repository.
 */
export function prUrlForge(
  prUrl: string,
  remotes: readonly { name: string; url: string }[],
): { kind: ForgeKind; remote: string } | null {
  let url: URL
  try {
    url = new URL(prUrl)
  } catch {
    return null
  }
  for (const { kind, re } of PR_PATHS) {
    const repo = url.pathname.match(re)?.[1]?.toLowerCase()
    if (repo === undefined) continue
    const remote = remotes.find((r) => {
      const parsed = parseRemote(r.url)
      return (
        parsed !== null &&
        new URL(parsed.base).hostname === url.hostname &&
        parsed.ownerRepo.toLowerCase() === repo
      )
    })
    return remote === undefined ? null : { kind, remote: remote.name }
  }
  return null
}

/**
 * Routes a task's PR to the forge it was opened on, so PRs opened before
 * `forge.kind` changed keep being reconciled and conflict-resolved there.
 * Anything unrecognized, and anything on the configured forge, goes to the
 * workspace's own `driver` and `config`.
 */
export function prForgeRouter(
  root: string,
  config: Config,
  driver: PrDriver,
  makeDriver: (kind: ForgeKind, remote: string) => PrDriver = makePrDriver,
  remotes: () => readonly { name: string; url: string }[] = () => gitRemoteUrls(root),
): (prUrl: string | null) => PrForge {
  const drivers = new Map<string, PrDriver>()
  return (prUrl) => {
    const primary = { key: PRIMARY_FORGE, config, driver }
    const route = prUrl === null ? null : prUrlForge(prUrl, remotes())
    if (route === null) return primary
    if (route.kind === config.forge.kind && route.remote === config.forge.remote) return primary
    const key = `${route.kind}:${route.remote}`
    let foreign = drivers.get(key)
    if (foreign === undefined) {
      foreign = makeDriver(route.kind, route.remote)
      drivers.set(key, foreign)
    }
    return { key, config: { ...config, forge: { ...config.forge, ...route } }, driver: foreign }
  }
}
