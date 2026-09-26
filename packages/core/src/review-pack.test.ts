import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ejectReviewPack, reviewPrompt } from './review-pack.ts'

let temp: string
let repo: string
let previousConfigHome: string | undefined

function writePackFile(root: string, path: string, content: string): void {
  const file = join(root, path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}

function prompt(changedFiles: string[], disabledLenses?: string[]): string {
  return reviewPrompt({
    repoRoot: repo,
    changedFiles,
    ...(disabledLenses === undefined ? {} : { disabledLenses }),
    roundInstructions: 'Round 1: inspect the full change.',
  })
}

beforeEach(() => {
  temp = mkdtempSync(join(import.meta.dir, '.review-pack-test-'))
  repo = join(temp, 'repo')
  mkdirSync(repo)
  previousConfigHome = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(temp, 'config')
})

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
  rmSync(temp, { recursive: true, force: true })
})

describe('reviewPrompt', () => {
  test('applies repo over user over built-in and adds new matching lenses', () => {
    const user = join(temp, 'config', 'amagi', 'review')
    writePackFile(user, 'review.md', 'User core')
    writePackFile(user, 'lenses/typescript.md', 'User TypeScript lens without a match declaration')
    writePackFile(user, 'lenses/custom.md', '---\nmatch: ["package.json"]\n---\nAdded user lens')
    writePackFile(repo, '.amagi/review/review.md', 'Repo core')
    writePackFile(
      repo,
      '.amagi/review/lenses/typescript.md',
      '---\nmatch: ["**/*.ts"]\n---\nRepo TypeScript lens',
    )

    const result = prompt(['src/index.ts', 'package.json'])
    expect(result).toContain('Repo core')
    expect(result).not.toContain('User core')
    expect(result).toContain('Repo TypeScript lens')
    expect(result).not.toContain('User TypeScript lens')
    expect(result).toContain('Added user lens')
    expect(result).not.toContain('match:')
    expect(result).toContain('Lens: base')
  })

  test('disables a selected lens by name', () => {
    writePackFile(
      repo,
      '.amagi/review/lenses/security.md',
      '---\nmatch: ["**/*.ts"]\n---\nSecurity lens body',
    )
    expect(prompt(['src/index.ts'], ['security'])).not.toContain('Security lens body')
  })

  test('uses [review].lenses from the layered repository config', () => {
    writePackFile(
      repo,
      '.amagi/review/lenses/security.md',
      '---\nmatch: ["**/*.ts"]\n---\nSecurity lens body',
    )
    writePackFile(repo, '.amagi/config.toml', '[review]\nlenses = ["security"]\n')
    expect(prompt(['src/index.ts'])).not.toContain('Security lens body')
  })

  test('uses only base when no lens matches the changed files', () => {
    writePackFile(
      repo,
      '.amagi/review/lenses/rust.md',
      '---\nmatch:\n  - "**/*.rs"\n---\nRust lens body',
    )
    const result = prompt(['legacy/main.cbl'])
    expect(result).toContain('Lens: base')
    expect(result).not.toContain('Rust lens body')
  })

  test('always appends the generated finding contract after user core content', () => {
    writePackFile(repo, '.amagi/review/review.md', 'User-authored core without a contract')
    const result = prompt([])
    expect(result).toContain('User-authored core without a contract')
    expect(result).toContain('Required findings output')
    expect(result).toContain('failureScenario')
    expect(result).toContain('- blocker\n- major\n- minor\n- nit')
  })
})

describe('ejectReviewPack', () => {
  test('writes to user or repository config and refuses to overwrite without force', () => {
    const userTarget = ejectReviewPack({ repoRoot: repo })
    const userCore = join(userTarget, 'review.md')
    expect(readFileSync(userCore, 'utf8')).toContain('Review discipline')
    expect(() => ejectReviewPack({ repoRoot: repo })).toThrow(/pass --force/)

    writeFileSync(userCore, 'customized')
    ejectReviewPack({ repoRoot: repo, force: true })
    expect(readFileSync(userCore, 'utf8')).toContain('Review discipline')

    const repoTarget = ejectReviewPack({ repoRoot: repo, repo: true })
    expect(readFileSync(join(repoTarget, 'lenses', 'base.md'), 'utf8')).toContain(
      'Review the whole change',
    )
  })
})
