import { describe, expect, test } from 'bun:test'
import { childPids, killTree, processTree } from './process.ts'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('process tree', () => {
  test('finds grandchildren, not just direct children', async () => {
    const proc = Bun.spawn(['sh', '-c', 'sh -c "sleep 30" & sleep 30'], { stdout: 'ignore' })
    try {
      await Bun.sleep(300)
      const tree = await processTree(proc.pid)
      expect(tree[0]).toBe(proc.pid)
      expect(tree.length).toBeGreaterThanOrEqual(3)
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })

  test('a leaf process has no children', async () => {
    const proc = Bun.spawn(['sleep', '30'], { stdout: 'ignore' })
    try {
      await Bun.sleep(200)
      expect(await childPids(proc.pid)).toEqual([])
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })

  test('killing leaves no orphaned descendants behind', async () => {
    const proc = Bun.spawn(['sh', '-c', 'sh -c "sleep 30" & sleep 30'], { stdout: 'ignore' })
    await Bun.sleep(300)
    const tree = await processTree(proc.pid)
    expect(tree.length).toBeGreaterThanOrEqual(3)

    await killTree(proc.pid, { graceMs: 100 })
    await Bun.sleep(200)

    expect(tree.filter(alive)).toEqual([])
  })

  test('killing an already dead process is not an error', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore' })
    await proc.exited
    expect(killTree(proc.pid, { graceMs: 10 })).resolves.toBeDefined()
  })
})
