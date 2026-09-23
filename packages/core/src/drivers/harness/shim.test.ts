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

/** PATH with every amagi git shim dir removed, so `git` is the real binary. */
function pathWithoutShims(): string {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((dir) => {
      if (dir === '') return false
      try {
        return !readFileSync(join(dir, 'git'), 'utf8').includes('REAL_GIT=')
      } catch {
        return true
      }
    })
    .join(':')
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

describe('defense-in-depth limits', () => {
  const commits = (dir: string) => git(dir, ['rev-list', '--count', 'HEAD']).stdout.trim()

  test('an absolute real git path bypasses the shim', () => {
    const real = Bun.which('git', { PATH: pathWithoutShims() })
    expect(real).toBeTruthy()
    if (!real) throw new Error('git not found')
    const r = Bun.spawnSync([real, 'commit', '--allow-empty', '-m', 'abs'], {
      cwd: wt,
      env: { ...process.env, ...withWorktree({ AMAGI_WORKTREE: 'WT' }) },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
  })

  test('a PATH without the shim resolves the real git', () => {
    const r = Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'noshim'], {
      cwd: wt,
      env: {
        ...process.env,
        PATH: pathWithoutShims(),
        ...withWorktree({ AMAGI_WORKTREE: 'WT' }),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
  })

  test('--work-tree retargets the reported worktree, the write lands in the protected repo', () => {
    const r = shimGit(
      wt,
      ['--work-tree', other, 'commit', '--allow-empty', '-m', 'wt-flag'],
      withWorktree({ AMAGI_WORKTREE: 'WT' }),
    )
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
  })

  test('GIT_WORK_TREE env retargets the reported worktree', () => {
    const r = shimGit(wt, ['commit', '--allow-empty', '-m', 'wt-env'], {
      ...withWorktree({ AMAGI_WORKTREE: 'WT' }),
      GIT_WORK_TREE: other,
    })
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
  })

  test('--git-dir and --work-tree from elsewhere target the protected repo', () => {
    const r = shimGit(
      other,
      [
        '--git-dir',
        join(wt, '.git'),
        '--work-tree',
        other,
        'commit',
        '--allow-empty',
        '-m',
        'gd-flag',
      ],
      withWorktree({ AMAGI_WORKTREE: 'WT', AMAGI_REPO_ROOT: 'WT' }),
    )
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
  })

  test('GIT_DIR and GIT_WORK_TREE env from elsewhere target the protected repo', () => {
    const r = shimGit(other, ['commit', '--allow-empty', '-m', 'gd-env'], {
      ...withWorktree({ AMAGI_WORKTREE: 'WT', AMAGI_REPO_ROOT: 'WT' }),
      GIT_DIR: join(wt, '.git'),
      GIT_WORK_TREE: other,
    })
    expect(r.exitCode).toBe(0)
    expect(commits(wt)).toBe('2')
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

describe('git shim self-reference guard', () => {
  test('prepareShim resolves the real git even when the shim dir is first on PATH', () => {
    const saved = process.env.PATH
    process.env.PATH = `${shim}:${saved ?? ''}`
    try {
      const dir = prepareShim()
      const script = readFileSync(join(dir, 'git'), 'utf8')
      const real = /^REAL_GIT='(.*)'$/m.exec(script)?.[1]
      expect(real).toBeDefined()
      expect(real).not.toBe(join(dir, 'git'))
      expect(real).not.toBe('git')
    } finally {
      if (saved === undefined) delete process.env.PATH
      else process.env.PATH = saved
    }
  })

  // A shim that execs itself forks without bound until the host's pid table is
  // full, so the generated script must refuse even when handed a poisoned
  // REAL_GIT it did not write. Both cases run with no real git on PATH: a
  // regression here hangs the test rather than bombing the machine.
  test('a shim whose REAL_GIT points at itself refuses to run', () => {
    const bin = join(home, 'poisoned')
    mkdirSync(bin, { recursive: true })
    const self = join(bin, 'git')
    const script = readFileSync(join(shim, 'git'), 'utf8')
      .replace(/^REAL_GIT='.*'$/m, `REAL_GIT='${self}'`)
      .replace(/^SHIM_BIN='.*'$/m, `SHIM_BIN='${bin}'`)
    writeFileSync(self, script)
    chmodSync(self, 0o755)

    const r = Bun.spawnSync([self, 'status'], {
      cwd: wt,
      env: { ...process.env, PATH: bin },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('refusing to run')
  })

  test('an empty REAL_GIT falls back to a PATH scan that skips the shim dir', () => {
    const bin = join(home, 'empty-real')
    mkdirSync(bin, { recursive: true })
    const self = join(bin, 'git')
    const script = readFileSync(join(shim, 'git'), 'utf8')
      .replace(/^REAL_GIT='.*'$/m, "REAL_GIT=''")
      .replace(/^SHIM_BIN='.*'$/m, `SHIM_BIN='${bin}'`)
    writeFileSync(self, script)
    chmodSync(self, 0o755)

    const r = Bun.spawnSync([self, 'status'], {
      cwd: wt,
      env: { ...process.env, PATH: bin },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.toString()).toContain('refusing to run')
  })
})
