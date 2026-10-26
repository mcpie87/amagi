import { describe, expect, test } from 'bun:test'
import { exec } from './exec.ts'

describe('exec timeout', () => {
  test('fails a timed-out command even when it exits 0 on SIGTERM', async () => {
    const result = await exec(['sh', '-c', "trap 'exit 0' TERM; sleep 30 & wait"], {
      timeoutMs: 300,
    })

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain('timed out after 300ms')
  })

  test('stops waiting on output held open by a descendant that left the process tree', async () => {
    const started = Date.now()
    const result = await exec(['sh', '-c', '(sleep 3 &); exit 0'], { timeoutMs: 300 })

    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.exitCode).toBe(124)
  })
})
