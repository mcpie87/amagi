import { describe, expect, test } from 'bun:test'
import {
  childPids,
  killDescendantsSync,
  killTree,
  pidAlive,
  processTree,
  processTreeStats,
} from './process.ts'

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

  test('synchronous shutdown kills grandchildren without killing the calling process', async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const child = Bun.spawn(['sh', '-c', 'sleep 30 & echo $!; wait'], { stdout: 'pipe' });
         const reader = child.stdout.getReader();
         const leaf = new TextDecoder().decode((await reader.read()).value).trim();
         console.log(leaf);
         await child.exited;
         console.log('stopped');
         await Bun.sleep(30000);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const reader = proc.stdout.getReader()
    try {
      const leaf = Number(new TextDecoder().decode((await reader.read()).value).trim())
      expect(pidAlive(leaf)).toBe(true)
      killDescendantsSync(proc.pid)
      expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('stopped')
      expect(pidAlive(leaf)).toBe(false)
      expect(pidAlive(proc.pid)).toBe(true)
    } finally {
      proc.kill('SIGKILL')
      await proc.exited
      reader.releaseLock()
    }
  })

  test.skipIf(process.platform !== 'linux')('a zombie is not alive', async () => {
    const proc = Bun.spawn(['sh', '-c', 'true & exec sleep 30'], { stdout: 'ignore' })
    try {
      await Bun.sleep(300)
      const [zombie] = await childPids(proc.pid)
      if (zombie === undefined) throw new Error('no unreaped child left behind')
      expect(alive(zombie)).toBe(true)
      expect(pidAlive(zombie)).toBe(false)
      expect(pidAlive(proc.pid)).toBe(true)
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })

  test('killing an already dead process is not an error', async () => {
    const proc = Bun.spawn(['true'], { stdout: 'ignore' })
    await proc.exited
    expect(killTree(proc.pid, { graceMs: 10 })).resolves.toBeDefined()
  })

  test('processTreeStats sums the whole tree, not just the root', async () => {
    const proc = Bun.spawn(['sh', '-c', 'sh -c "sleep 30" & sleep 30'], { stdout: 'ignore' })
    try {
      await Bun.sleep(200)
      const stats = await processTreeStats(proc.pid)
      expect(stats.processes).toBeGreaterThanOrEqual(3)
      // RSS and CPU time are real on linux (/proc); elsewhere they read as zero.
      expect(stats.rssBytes).toBeGreaterThanOrEqual(0)
      expect(stats.cpuMs).toBeGreaterThanOrEqual(0)
    } finally {
      await killTree(proc.pid, { graceMs: 50 })
    }
  })
})
