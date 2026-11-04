import {
  configSettingOrigins,
  EDITABLE_SETTINGS,
  errMsg,
  gitPersonas,
  loadConfig,
  loadGlobalConfig,
  type RunServiceApi,
  settingPatch,
  settingValue,
  type Workspaces,
  writeConfig,
  writeGlobalConfig,
} from '@amagi/core'
import { WorktreePool } from '@amagi/core/worktree-pool'
import { Hono } from 'hono'
import * as z from 'zod'
import { resolveSetup, valid } from './route-utils.ts'
import { RepoParam } from './schemas.ts'

/** Path to value; null resets the key to its default. */
const ConfigParam = z.object({ repo: RepoParam.shape.repo.optional() })
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

  const setup = (repo?: string) =>
    repo === undefined ? { root: null, config: loadGlobalConfig() } : resolveSetup(workspaces, repo)
  const view = async (repo?: string) => {
    const ws = setup(repo)
    return {
      values: Object.fromEntries(
        EDITABLE_SETTINGS.map(({ path }) => [path, settingValue(ws.config, path) ?? null]),
      ),
      origins: configSettingOrigins(
        ws.root,
        EDITABLE_SETTINGS.map(({ path }) => path),
      ),
      server: ws.config.server,
      personas: gitPersonas(),
      running: repo === undefined ? false : await running(repo),
    }
  }

  const app = new Hono()
  for (const path of ['/api/config', '/api/repos/:repo/config']) {
    app
      .get(path, valid('param', ConfigParam), async (c) =>
        c.json(await view(c.req.valid('param').repo)),
      )

      .patch(path, valid('param', ConfigParam), valid('json', ConfigBody), async (c) => {
        const { repo } = c.req.valid('param')
        const ws = setup(repo)
        const entries = Object.entries(c.req.valid('json').values)
        const settings = entries.map(([path]) => EDITABLE_SETTINGS.find((s) => s.path === path))
        const unknown = entries
          .filter(
            (_, i) =>
              settings[i] === undefined || (repo === undefined && settings[i]?.layer !== 'global'),
          )
          .map(([path]) => path)
        if (unknown.length > 0) {
          return c.json({ error: `not editable here: ${unknown.join(', ')}` }, 400)
        }
        const blocked = settings.filter((s) => s !== undefined && 'idleOnly' in s)
        if (blocked.length > 0 && repo !== undefined && (await running(repo))) {
          return c.json(
            {
              error: `stop the running tasks first: changing ${blocked.map((s) => s?.path).join(', ')} would strand their worktrees`,
            },
            409,
          )
        }
        if (
          ws.root !== null &&
          entries.some(
            ([path, value]) =>
              path === 'repo.worktreeRoot' && value !== ws.config.repo.worktreeRoot,
          )
        ) {
          const pool = new WorktreePool({
            repoRoot: ws.root,
            worktreeRoot: ws.config.repo.worktreeRoot,
            baseBranch: ws.config.repo.baseBranch,
          })
          if (pool.hasReservations())
            return c.json(
              { error: 'reset or resume reserved worktrees before changing the worktree root' },
              409,
            )
        }
        const persona = entries.find(([path]) => path === 'repo.persona')?.[1]
        if (typeof persona === 'string' && !gitPersonas().includes(persona)) {
          return c.json({ error: `no git persona named ${persona}` }, 400)
        }

        const repoPatch: Record<string, unknown> = {}
        const globalPatch: Record<string, unknown> = {}
        entries.forEach(([path, value], i) => {
          let node = settings[i]?.layer === 'global' ? globalPatch : repoPatch
          const keys = path.split('.')
          const last = keys.pop() as string
          for (const key of keys) {
            node[key] ??= {}
            node = node[key] as Record<string, unknown>
          }
          node[last] = value
        })
        try {
          if (ws.root !== null)
            loadConfig(ws.root, { allowIncompleteChecks: true, repoPatch, globalPatch })
          else loadGlobalConfig(globalPatch)
        } catch (error) {
          return c.json({ error: errMsg(error) }, 400)
        }

        entries.forEach(([path, value], i) => {
          const patch = settingPatch(path, value)
          if (settings[i]?.layer === 'global') writeGlobalConfig(patch)
          else if (ws.root !== null) writeConfig(ws.root, patch)
        })
        const globalSections = new Set(
          entries
            .filter((_, i) => settings[i]?.layer === 'global')
            .map(([path]) => path.split('.')[0] as string),
        )
        const repoSections = new Set(
          entries
            .filter((_, i) => settings[i]?.layer === 'repo')
            .map(([path]) => path.split('.')[0] as string),
        )
        workspaces.refreshConfig(globalSections)
        if (repo !== undefined) workspaces.refreshConfig(repoSections, repo)
        return c.json(await view(repo))
      })
  }
  return app
}
