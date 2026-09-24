import { readFileSync } from 'node:fs'
import { exec as defaultExec, type Exec } from './exec.ts'

/**
 * Bun.spawn kills only the direct child and exposes no way to put the child in
 * its own process group, so an agent that shelled out leaves the grandchildren
 * running. setsid would isolate them but does not hand the new group id back to
 * the parent, and it is absent on darwin, so descendants are walked explicitly.
 */
export async function childPids(pid: number, run: Exec = defaultExec): Promise<number[]> {
  const r = await run(['pgrep', '-P', String(pid)])
  if (r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** Breadth first, so the returned order is parents before children. */
export async function processTree(pid: number, run: Exec = defaultExec): Promise<number[]> {
  const found: number[] = []
  const queue = [pid]
  const seen = new Set<number>([pid])

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    found.push(current)
    for (const child of await childPids(current, run)) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return found
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone, or reparented away from us. Either way there is nothing to do.
  }
}

/** Whether a pid still exists; signal 0 checks liveness without delivering one. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export type ProcessTreeStats = {
  processes: number
  rssBytes: number
  cpuMs: number
}

/** USER_HZ is 100 on every Linux arch; /proc stat times are counted in these ticks. */
const USER_HZ = 100

function procRssBytes(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const line = status.split('\n').find((l) => l.startsWith('VmRSS:'))
    if (line === undefined) return 0
    const kB = Number.parseInt(line.slice('VmRSS:'.length).trim(), 10)
    return Number.isFinite(kB) ? kB * 1024 : 0
  } catch {
    return 0
  }
}

/** utime+stime from /proc/<pid>/stat; the comm field may contain spaces, so fields start after the last ')'. */
function procCpuMs(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const utime = Number(fields[11])
    const stime = Number(fields[12])
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return 0
    return ((utime + stime) * 1000) / USER_HZ
  } catch {
    return 0
  }
}

/**
 * Summed RSS, CPU time and process count over the whole tree rooted at pid,
 * read from /proc on Linux. Non-Linux hosts have no /proc, so cpu and rss come
 * back as zero while the process count still reflects the real tree.
 */
export async function processTreeStats(pid: number): Promise<ProcessTreeStats> {
  const tree = await processTree(pid)
  let rssBytes = 0
  let cpuMs = 0
  for (const p of tree) {
    rssBytes += procRssBytes(p)
    cpuMs += procCpuMs(p)
  }
  return { processes: tree.length, rssBytes, cpuMs }
}

export type KillTreeOptions = {
  graceMs?: number
  exec?: Exec
}

/**
 * Children are signalled before their parents so a supervising parent cannot
 * notice the death and respawn before it is itself stopped.
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<number[]> {
  const graceMs = opts.graceMs ?? 2000
  const tree = await processTree(pid, opts.exec ?? defaultExec)
  const deepestFirst = [...tree].reverse()

  for (const p of deepestFirst) signal(p, 'SIGTERM')
  await Bun.sleep(graceMs)
  for (const p of deepestFirst) signal(p, 'SIGKILL')

  return tree
}
