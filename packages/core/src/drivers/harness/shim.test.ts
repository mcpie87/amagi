import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareShim } from './shim.ts'

const savedState = process.env.XDG_STATE_HOME
let home: string
let shim: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'amagi-shim-'))
  process.env.XDG_STATE_HOME = home
  shim = prepareShim()
})

afterEach(() => {
  if (savedState === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = savedState
  rmSync(home, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

/** A real repo with one commit on `main` containing `file.txt`. */
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'file.txt'), 'hello\n')
  git(dir, ['add', 'file.txt'])
  git(dir, ['commit', '-q', '-m', 'base'])
}

/** Runs the git shim like an agent shell would, in `cwd` with the given env. */
function shimGit(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync([join(shim, 'git'), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
}

function withWorktree(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === 'WT') out[k] = wt
    else out[k] = v
  }
  return out
}

let wt: string
let other: string

beforeEach(() => {
  wt = join(home, 'wt')
  other = join(home, 'other')
  makeRepo(wt)
  makeRepo(other)
})

describe('git shim', () => {
  test('is generated into the state home shim dir', () => {
    expect(shim).toBe(join(home, 'amagi', 'shim', 'bin'))
    expect(existsSync(join(shim, 'git'))).toBe(true)
    expect(existsSync(join(shim, 'amagi'))).toBe(true)
  })

  test('rejects write verbs inside the worktree', () => {
    for (const args of [
      ['commit', '--allow-empty', '-m', 'x'],
      ['add', '-A'],
      ['push'],
      ['checkout', '--', '.'],
      ['restore', '.'],
      ['clean', '-fd'],
      ['apply', 'x.patch'],
      ['reset', '--hard'],
      ['merge', 'main'],
      ['stash'],
    ]) {
      const r = shimGit(wt, args, withWorktree({ AMAGI_WORKTREE: 'WT' }))
      expect(r.exitCode, `git ${args.join(' ')} should be rejected`).not.toBe(0)
    }
  })

  test('allows read verbs inside the worktree', () => {
    for (const args of [
      ['status', '--porcelain'],
      ['diff'],
      ['log', '--oneline'],
      ['show', 'HEAD'],
      ['rev-parse', 'HEAD'],
      ['ls-files'],
      ['blame', '--', 'file.txt'],
      ['cat-file', '-t', 'HEAD'],
      ['describe', '--always'],
      ['branch', '--list'],
      ['worktree', 'list'],
    ]) {
      const r = shimGit(wt, args, withWorktree({ AMAGI_WORKTREE: 'WT' }))
      expect(r.exitCode, `git ${args.join(' ')} should be allowed`).toBe(0)
    }
  })

  test('rejects branch without --list and worktree without list', () => {
    expect(
      shimGit(wt, ['branch', 'new'], withWorktree({ AMAGI_WORKTREE: 'WT' })).exitCode,
    ).not.toBe(0)
    expect(
      shimGit(wt, ['worktree', 'add', 'x'], withWorktree({ AMAGI_WORKTREE: 'WT' })).exitCode,
    ).not.toBe(0)
  })

  test('allows git init and commit in a repo outside the worktree', () => {
    const r = shimGit(other, ['commit', '--allow-empty', '-m', 'x'], {
      ...withWorktree({ AMAGI_WORKTREE: 'WT' }),
    })
    expect(r.exitCode).toBe(0)
  })

  test('scopes by -C, honouring the effective repository', () => {
    expect(
      shimGit(
        wt,
        ['-C', other, 'commit', '--allow-empty', '-m', 'x'],
        withWorktree({ AMAGI_WORKTREE: 'WT' }),
      ).exitCode,
    ).toBe(0)
    expect(
      shimGit(
        wt,
        ['-C', wt, 'commit', '--allow-empty', '-m', 'x'],
        withWorktree({ AMAGI_WORKTREE: 'WT' }),
      ).exitCode,
    ).not.toBe(0)
  })

  test('passes everything through when no protected root is set', () => {
    expect(shimGit(wt, ['commit', '--allow-empty', '-m', 'x']).exitCode).toBe(0)
  })

  test('appends rejected argv as JSONL to the run state dir', () => {
    const run = join(home, 'run')
    shimGit(wt, ['commit', '-m', 'say "hi"'], {
      ...withWorktree({ AMAGI_WORKTREE: 'WT' }),
      AMAGI_RUN_STATE: run,
    })
    const file = join(run, 'rejected-git.jsonl')
    expect(existsSync(file)).toBe(true)
    const [line] = readFileSync(file, 'utf8').trim().split('\n')
    const entry = JSON.parse(line ?? '') as { argv: string[]; cwd: string; at: string }
    expect(entry.argv).toEqual(['commit', '-m', 'say "hi"'])
    expect(entry.cwd).toBe(wt)
    expect(entry.at).toBeTruthy()
  })
})

describe('amagi shim', () => {
  test('allows only ask and git-request', () => {
    const fakeBin = join(home, 'fakebin')
    mkdirSync(fakeBin, { recursive: true })
    const fake = join(fakeBin, 'amagi')
    writeFileSync(fake, '#!/bin/sh\necho "REAL: $*"\nexit 0\n')
    chmodSync(fake, 0o755)
    const withFake = prepareShim()
    const amagi = join(withFake, 'amagi')
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }

    const run = (args: string[]) => {
      const r = Bun.spawnSync([amagi, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
      return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
    }

    expect(run(['ask', 'a question']).stdout).toBe('REAL: ask a question\n')
    expect(run(['git-request', 'commit']).stdout).toBe('REAL: git-request commit\n')
    for (const args of [[], ['run'], ['continue'], ['clean'], ['status'], ['--help']]) {
      expect(run(args).exitCode, `amagi ${args.join(' ')} should be rejected`).not.toBe(0)
    }
  })
})
