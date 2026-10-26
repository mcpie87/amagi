import {
  Config,
  EDITABLE_SETTINGS,
  gitPersonas,
  loadConfig,
  type RunServiceApi,
  settingPatch,
  settingValue,
  type Workspaces,
  writeConfig,
  writeGlobalConfig,
} from '@amagi/core'
import { Hono } from 'hono'
import * as z from 'zod'
import { resolveWorkspace, valid } from './route-utils.ts'
import { RepoParam } from './schemas.ts'

/** Path to value; null resets the key to its default. */
const ConfigBody = z.object({ values: z.record(z.string(), z.unknown()) })

export type ConfigRouteDeps = {
  workspaces: Workspaces
  runnerFor: (repo: string) => RunServiceApi | undefined
}

/**
 * The settings listed in EDITABLE_SETTINGS, read from and written to the
 * config layer each one lives in. A patch is validated against the whole
 * Config schema before anything is written.
 */
export function createConfigRoutes({ workspaces, runnerFor }: ConfigRouteDeps) {
  const running = async (repo: string): Promise<boolean> =>
    ((await runnerFor(repo)?.status())?.running.length ?? 0) > 0

  const view = async (repo: string) => {
    const ws = resolveWorkspace(workspaces, repo)
    return {
      values: Object.fromEntries(
        EDITABLE_SETTINGS.map(({ path }) => [path, settingValue(ws.config, path) ?? null]),
      ),
      server: ws.config.server,
      personas: gitPersonas(),
      running: await running(repo),
    }
  }

  return new Hono()
    .get('/api/repos/:repo/config', valid('param', RepoParam), async (c) =>
      c.json(await view(c.req.valid('param').repo)),
    )

    .patch(
      '/api/repos/:repo/config',
      valid('param', RepoParam),
      valid('json', ConfigBody),
      async (c) => {
        const { repo } = c.req.valid('param')
        const ws = resolveWorkspace(workspaces, repo)
        const entries = Object.entries(c.req.valid('json').values)
        const settings = entries.map(([path]) => EDITABLE_SETTINGS.find((s) => s.path === path))
        const unknown = entries.filter((_, i) => settings[i] === undefined).map(([path]) => path)
        if (unknown.length > 0) {
          return c.json({ error: `not editable here: ${unknown.join(', ')}` }, 400)
        }
        const blocked = settings.filter((s) => s !== undefined && 'idleOnly' in s)
        if (blocked.length > 0 && (await running(repo))) {
          return c.json(
            {
              error: `stop the running tasks first: changing ${blocked.map((s) => s?.path).join(', ')} would strand their worktrees`,
            },
            409,
          )
        }
        const persona = entries.find(([path]) => path === 'repo.persona')?.[1]
        if (typeof persona === 'string' && !gitPersonas().includes(persona)) {
          return c.json({ error: `no git persona named ${persona}` }, 400)
        }

        const candidate = structuredClone(ws.config) as Record<string, unknown>
        for (const [path, value] of entries) {
          const keys = path.split('.')
          const last = keys.pop() as string
          let node = candidate
          for (const key of keys) node = node[key] as Record<string, unknown>
          if (value === null) delete node[last]
          else node[last] = value
        }
        const parsed = Config.safeParse(candidate)
        if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400)

        entries.forEach(([path, value], i) => {
          const patch = settingPatch(path, value)
          if (settings[i]?.layer === 'global') writeGlobalConfig(patch)
          else writeConfig(ws.root, patch)
        })
        // Sections are refreshed in place: pollers and runners hold this config object.
        const fresh = loadConfig(ws.root).config as unknown as Record<
          string,
          Record<string, unknown>
        >
        const live = ws.config as unknown as Record<string, Record<string, unknown>>
        for (const section of new Set(entries.map(([path]) => path.split('.')[0] as string))) {
          const target = live[section]
          const source = fresh[section]
          if (target === undefined || source === undefined) continue
          for (const key of Object.keys(target)) if (!(key in source)) delete target[key]
          Object.assign(target, source)
        }
        return c.json(await view(repo))
      },
    )
}
