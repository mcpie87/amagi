import { expect, test } from 'bun:test'
import { stageAndCommit } from './commit.ts'
import type { Exec } from './exec.ts'

test('a failed git add aborts before committing', async () => {
  const calls: string[] = []
  const exec: Exec = async (cmd) => {
    calls.push(cmd[1] ?? '')
    if (cmd[1] === 'status') return { exitCode: 0, stdout: ' M file.ts\n', stderr: '' }
    if (cmd[1] === 'add') return { exitCode: 128, stdout: '', stderr: 'index.lock exists' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  await expect(
    stageAndCommit(exec, { id: 'am-1', title: 'Task' }, '/wt', 'Did the thing.', {
      harness: 'claude',
      model: null,
      effort: null,
    }),
  ).rejects.toThrow('index.lock exists')
  expect(calls).not.toContain('commit')
})

test('a failed git status throws instead of reading as no changes', async () => {
  const exec: Exec = async (cmd) =>
    cmd[1] === 'status'
      ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
      : { exitCode: 0, stdout: '', stderr: '' }
  await expect(
    stageAndCommit(exec, { id: 'am-1', title: 'Task' }, '/wt', 'Did the thing.', {
      harness: 'claude',
      model: null,
      effort: null,
    }),
  ).rejects.toThrow('not a git repository')
})
