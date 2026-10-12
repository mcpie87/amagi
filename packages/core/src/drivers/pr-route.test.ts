import { expect, test } from 'bun:test'
import { Config } from '../config.ts'
import type { PrDriver } from './pr.ts'
import { PRIMARY_FORGE, prForgeRouter, prUrlForge } from './pr-route.ts'

const remotes = [
  { name: 'origin', url: 'git@github.com:Owner/Repo.git' },
  { name: 'gitlab', url: 'git@gitlab.com:owner/repo.git' },
  { name: 'local', url: 'http://localhost:25001/owner/repo.git' },
]

test('prUrlForge maps each forge PR link to the remote hosting that repository', () => {
  expect(prUrlForge('https://github.com/owner/repo/pull/7', remotes)).toEqual({
    kind: 'github',
    remote: 'origin',
  })
  expect(prUrlForge('https://gitlab.com/owner/repo/-/merge_requests/3', remotes)).toEqual({
    kind: 'gitlab',
    remote: 'gitlab',
  })
  expect(prUrlForge('http://localhost:25001/owner/repo/pulls/9', remotes)).toEqual({
    kind: 'forgejo',
    remote: 'local',
  })
})

test('prUrlForge is null for other repositories and non-PR links', () => {
  expect(prUrlForge('https://github.com/owner/other/pull/7', remotes)).toBeNull()
  expect(prUrlForge('https://github.com/owner/repo/issues/7', remotes)).toBeNull()
  expect(prUrlForge('not a url', remotes)).toBeNull()
})

test('prForgeRouter keeps configured-forge PRs on the workspace driver and reuses foreign drivers', () => {
  const config = Config.parse({
    repo: { baseBranch: 'main', worktreeRoot: '/wt' },
    forge: { kind: 'gitlab', remote: 'gitlab' },
  })
  const primary = {} as PrDriver
  const made: string[] = []
  const route = prForgeRouter(
    '/repo',
    config,
    primary,
    (kind, remote) => {
      made.push(`${kind}:${remote}`)
      return {} as PrDriver
    },
    () => remotes,
  )

  expect(route(null)).toEqual({ key: PRIMARY_FORGE, config, driver: primary })
  expect(route('https://gitlab.com/owner/repo/-/merge_requests/3').driver).toBe(primary)
  const github = route('https://github.com/owner/repo/pull/7')
  expect(github.key).toBe('github:origin')
  expect(github.config.forge.kind).toBe('github')
  expect(github.config.forge.remote).toBe('origin')
  expect(route('https://github.com/owner/repo/pull/8').driver).toBe(github.driver)
  expect(made).toEqual(['github:origin'])
})
