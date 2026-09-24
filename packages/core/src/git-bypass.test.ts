import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from './exec.ts'
import { headReflogEntriesSince, withHeadReflogBypassCheck } from './git-bypass.ts'

const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' })

describe('headReflogEntriesSince', () => {
  test('returns only new entries in newest-first order', () => {
    expect(
      headReflogEntriesSince(
        ['aaa checkout: moving from main to task', 'bbb clone: from origin'],
        [
          'ccc commit: unexpected commit',
          'aaa checkout: moving from main to task',
          'bbb clone: from origin',
        ],
      ),
    ).toEqual(['ccc commit: unexpected commit'])
  })
})

describe('withHeadReflogBypassCheck', () => {
  test('reports all agent-created HEAD reflog entries, including commits', async () => {
    const reflogs = [
      'aaa checkout: moving from main to task\nbbb clone: from origin\n',
      'ccc commit: unexpected commit\naaa checkout: moving from main to task\nbbb clone: from origin\n',
    ]
    const run: Exec = async () => ok(reflogs.shift() ?? '')
    const bypassed: string[][] = []

    await expect(
      withHeadReflogBypassCheck(
        '/worktree',
        run,
        async () => 'agent result',
        (entries) => bypassed.push(entries),
      ),
    ).resolves.toBe('agent result')

    expect(bypassed).toEqual([['ccc commit: unexpected commit']])
  })

  test('keeps the agent result when reflog inspection or reporting fails', async () => {
    let calls = 0
    const run: Exec = async () => {
      calls++
      return calls === 1
        ? ok('aaa checkout: initial\n')
        : { exitCode: 1, stdout: '', stderr: 'unavailable' }
    }

    await expect(
      withHeadReflogBypassCheck(
        '/worktree',
        run,
        async () => 'agent result',
        () => {
          throw new Error('event store unavailable')
        },
      ),
    ).resolves.toBe('agent result')
  })
})
