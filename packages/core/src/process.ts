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
