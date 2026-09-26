import { afterEach, expect, spyOn, test } from 'bun:test'
import { BeadsTracker, type Exec } from '@amagi/core'
import { startEpicClosePoller } from './epic-close-poller.ts'

const pollers: ReturnType<typeof startEpicClosePoller>[] = []

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
})

test('closes eligible epics with bd default reason and logs closed ids', async () => {
  const calls: string[][] = []
  const exec: Exec = async (cmd) => {
    calls.push([...cmd])
    return {
      exitCode: 0,
      stdout: JSON.stringify({ closed: ['am-1'], reason: 'All children completed' }),
      stderr: '',
    }
  }
  const info = spyOn(console, 'info').mockImplementation(() => {})
  const tracker = new BeadsTracker({ cwd: '/repo', exec })
  const poller = startEpicClosePoller({ repo: 'repo', tracker, intervalMs: 10 })
  pollers.push(poller)

  await Bun.sleep(35)
  poller.stop()

  expect(calls.length).toBeGreaterThanOrEqual(1)
  expect(calls[0]).toEqual([
    'bd',
    'epic',
    'close-eligible',
    '--reason',
    'All children completed',
    '--json',
  ])
  expect(info).toHaveBeenCalledWith('repo repo: closed eligible epics am-1')
  info.mockRestore()
})
