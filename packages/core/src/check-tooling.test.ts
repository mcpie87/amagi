import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedCheckTooling } from './check-tooling.ts'
import { exec, execOk } from './exec.ts'

let repo: string

afterEach(() => {
  if (repo !== undefined) rmSync(repo, { recursive: true, force: true })
})

async function initRepo(): Promise<void> {
  repo = mkdtempSync(join(tmpdir(), 'amagi-check-tooling-'))
  writeFileSync(join(repo, 'justfile'), 'check:\n    true\n')
  writeFileSync(join(repo, 'package.json'), '{"scripts":{"check":"just check"}}\n')
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, 'scripts', 'lint-commits.ts'), 'export {}\n')
  await execOk(exec, ['git', 'init', '-q', '-b', 'main'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.name', 'Test'], { cwd: repo })
  await execOk(exec, ['git', 'config', 'user.email', 'test@example.com'], { cwd: repo })
  await execOk(exec, ['git', 'add', '.'], { cwd: repo })
  await execOk(exec, ['git', 'commit', '-q', '-m', 'init'], { cwd: repo })
  await execOk(exec, ['git', 'switch', '-q', '-c', 'task'], { cwd: repo })
}

describe('changedCheckTooling', () => {
  test('allows worktrees without check tooling changes', async () => {
    await initRepo()
    writeFileSync(join(repo, 'source.ts'), 'export {}\n')
    expect(await changedCheckTooling(repo, exec, 'main')).toEqual([])
  })

  test('finds tracked and newly added check tooling files', async () => {
    await initRepo()
    writeFileSync(join(repo, 'justfile'), 'check:\n    true\n# changed\n')
    writeFileSync(join(repo, 'scripts', 'lint-commits.ts'), 'process.exit(0)\n')
    mkdirSync(join(repo, 'packages', 'example'), { recursive: true })
    writeFileSync(join(repo, 'packages', 'example', 'biome.jsonc'), '{}\n')

    expect(await changedCheckTooling(repo, exec, 'main')).toEqual([
      'justfile',
      'packages/example/biome.jsonc',
      'scripts/lint-commits.ts',
    ])
  })

  test('allows dependency and lockfile changes but rejects package script changes', async () => {
    await initRepo()
    writeFileSync(
      join(repo, 'package.json'),
      '{"scripts":{"check":"just check"},"dependencies":{"example":"1.0.0"}}\n',
    )
    writeFileSync(join(repo, 'bun.lock'), 'changed lockfile\n')
    expect(await changedCheckTooling(repo, exec, 'main')).toEqual([])

    writeFileSync(
      join(repo, 'package.json'),
      '{"scripts":{"check":"true"},"dependencies":{"example":"1.0.0"}}\n',
    )
    expect(await changedCheckTooling(repo, exec, 'main')).toEqual(['package.json'])
  })

  test('finds check tooling changes after a checkpoint commit', async () => {
    await initRepo()
    writeFileSync(join(repo, 'justfile'), 'check:\n    true\n# changed\n')
    await execOk(exec, ['git', 'add', 'justfile'], { cwd: repo })
    await execOk(exec, ['git', 'commit', '-q', '-m', 'checkpoint'], { cwd: repo })
    expect(await changedCheckTooling(repo, exec, 'main')).toEqual(['justfile'])
  })
})
