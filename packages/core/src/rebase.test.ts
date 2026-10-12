import { expect, test } from 'bun:test'
import { Config } from './config.ts'
import type { Exec, ExecResult } from './exec.ts'
import type { PrInfo } from './pr-check.ts'
import { withPrWriteLock } from './pr-write-lock.ts'
import { rebasePr } from './rebase.ts'

const pr: PrInfo = {
  number: 7,
  title: 'Task',
  body: '',
  url: 'https://example.test/pr/7',
  headRefName: 'amagi/am-1-task',
  baseRefName: 'main',
  headRefOid: 'head',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  createdAt: '',
  updatedAt: '',
  labels: [],
}

function fixture(
  over: (cmd: readonly string[]) => Partial<ExecResult> | undefined = () => undefined,
) {
  const calls: (readonly string[])[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd)
    const result: ExecResult = { exitCode: 0, stdout: '', stderr: '' }
    if (cmd[1] === 'rev-parse') result.stdout = 'head\n'
    if (cmd[1] === 'merge-base' || cmd[1] === 'diff') result.exitCode = 1
    if (cmd.includes('get-url')) result.stdout = 'https://example.test/owner/repo.git\n'
    if (cmd.includes('--symref')) result.stdout = 'ref: refs/heads/main\tHEAD\n'
    return { ...result, ...over(cmd) }
  }
  const config = Config.parse({
    repo: { setupCmd: 'setup' },
    checks: { format: 'format', lint: 'lint', commands: ['test'] },
  })
  const run = (idle = () => true) =>
    rebasePr({ root: '/repo', pr, baseOid: 'base', config, exec, idle })
  return { calls, config, run }
}

for (const kind of ['github', 'gitlab', 'forgejo'] as const) {
  test(`rebases and validates before a lease-protected push on ${kind}`, async () => {
    const f = fixture()
    f.config.forge.kind = kind
    expect(await f.run()).toBe('rebased')
    expect(f.calls.filter((cmd) => cmd[0] === 'sh').map((cmd) => cmd[2])).toEqual([
      'setup',
      'format',
      'lint',
      'test',
    ])
    const push = f.calls.find((cmd) => cmd[1] === 'push')
    expect(push).toEqual([
      'git',
      'push',
      '--force-with-lease=refs/heads/amagi/am-1-task:head',
      'origin',
      'HEAD:refs/heads/amagi/am-1-task',
    ])
    expect(f.calls.at(-1)?.slice(0, 4)).toEqual(['git', 'worktree', 'remove', '--force'])
  })
}

test('up-to-date and concurrently changed heads never create a worktree', async () => {
  for (const over of [
    (cmd: readonly string[]) => (cmd[1] === 'merge-base' ? { exitCode: 0 } : undefined),
    (cmd: readonly string[]) => (cmd[1] === 'rev-parse' ? { stdout: 'new-head' } : undefined),
  ]) {
    const f = fixture(over)
    expect(await f.run()).toBe('unchanged')
    expect(f.calls.some((cmd) => cmd[1] === 'worktree')).toBe(false)
  }
})

test('conflicts, failed checks and dirty check output never push and clean up', async () => {
  for (const over of [
    (cmd: readonly string[]) =>
      cmd[1] === 'rebase' && cmd[2] !== '--abort' ? { exitCode: 1, stderr: 'conflict' } : undefined,
    (cmd: readonly string[]) =>
      cmd[0] === 'sh' && cmd[2] === 'test' ? { exitCode: 1, stderr: 'test failed' } : undefined,
    (cmd: readonly string[]) => (cmd[1] === 'status' ? { stdout: ' M file.ts' } : undefined),
  ]) {
    const f = fixture(over)
    await expect(f.run()).rejects.toThrow()
    expect(f.calls.some((cmd) => cmd[1] === 'push')).toBe(false)
    expect(f.calls.at(-1)?.slice(0, 4)).toEqual(['git', 'worktree', 'remove', '--force'])
  }
})

test('a worker starting during checks prevents the push', async () => {
  let idle = true
  const f = fixture((cmd) => {
    if (cmd[0] === 'sh') idle = false
    return undefined
  })
  expect(await f.run(() => idle)).toBe('busy')
  expect(f.calls.some((cmd) => cmd[1] === 'push')).toBe(false)
})

test('a worker starting during push safety checks prevents the push', async () => {
  let idle = true
  const f = fixture((cmd) => {
    if (cmd.includes('--symref')) idle = false
    return undefined
  })
  expect(await f.run(() => idle)).toBe('busy')
  expect(f.calls.some((cmd) => cmd[1] === 'push')).toBe(false)
})

test('rebasing waits for a mention writer and refreshes its head afterwards', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let head = 'head'
  const writer = withPrWriteLock('/repo', 'origin', pr.headRefName, async () => {
    await pending
    head = 'edited-head'
  })
  const f = fixture((cmd) => (cmd[1] === 'rev-parse' ? { stdout: head } : undefined))
  const rebase = f.run()
  await Bun.sleep(1)
  expect(f.calls).toHaveLength(0)
  release()
  await writer
  expect(await rebase).toBe('unchanged')
  expect(f.calls.some((cmd) => cmd[1] === 'push')).toBe(false)
})

test('a rejected lease surfaces the push failure and cleans up', async () => {
  const f = fixture((cmd) =>
    cmd[1] === 'push' ? { exitCode: 1, stderr: 'stale info' } : undefined,
  )
  await expect(f.run()).rejects.toThrow('stale info')
  expect(f.calls.at(-1)?.slice(0, 4)).toEqual(['git', 'worktree', 'remove', '--force'])
})
