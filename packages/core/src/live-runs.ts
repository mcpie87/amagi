import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stateHome } from './paths.ts'
import { pidAlive, processTreeStats } from './process.ts'
import type { RunnerStatus, RunnerTask } from './run-service.ts'

/**
 * One task being worked by a runner that lives outside the server's own
 * RunService: a foreground `amagi run` / `just run` CLI process. The CLI
 * records it here at claim time and drops it on finish; the server reads the
 * file on every repo-scoped runner poll and merges the survivors into the worker
 * slots, so a worker the operator spawned in a terminal shows up in the
 * dashboard Workers section alongside server-launched ones.
 */
export type LiveRun = {
  /** The worker process (the CLI), the liveness signal for pruning. */
  pid: number
  repoKey: string
  repoName: string
  taskId: string
  title: string
  harness: string
  model: string | null
  effort: string | null
  /** Epoch ms at claim, for the same live elapsed-time display server runs get. */
  startedAt: number
}

/** Registry file under the state home; overridable so tests stay off the real one. */
export function liveRunsPath(): string {
  const override = process.env.AMAGI_LIVE_RUNS
  if (override) return override
  return join(stateHome(), 'amagi', 'live-runs.json')
}

function readLiveRuns(path: string): LiveRun[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (Array.isArray(parsed)) return parsed.filter((e): e is LiveRun => isLiveRun(e))
  } catch {
    // missing or corrupt: nothing is live
  }
  return []
}

function isLiveRun(e: unknown): e is LiveRun {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as LiveRun).pid === 'number' &&
    typeof (e as LiveRun).repoKey === 'string' &&
    typeof (e as LiveRun).taskId === 'string' &&
    typeof (e as LiveRun).title === 'string'
  )
}

function writeLiveRuns(path: string, runs: LiveRun[]): void {
  mkdirSync(dirname(path), { recursive: true })
  // Temp file + rename so a concurrent reader never sees a half-written file.
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(runs))
  renameSync(tmp, path)
}

/** Best effort: a broken registry must never take down the run or the server. */
function warn(err: unknown): void {
  console.warn(`live runs registry: ${err instanceof Error ? err.message : String(err)}`)
}

/** Records that the current process is working a task, replacing any prior record for the same repo+task. */
export function recordLiveRun(run: LiveRun, path = liveRunsPath()): void {
  try {
    // ponytail: single-file read-modify-write can lose an update when two CLI
    // runs in the same repo claim at the exact same instant; per-task files if
    // that ever happens.
    const runs = readLiveRuns(path).filter(
      (r) => !(r.repoKey === run.repoKey && r.taskId === run.taskId),
    )
    runs.push(run)
    writeLiveRuns(path, runs)
  } catch (err) {
    warn(err)
  }
}

/** Forgets a live run: its worker is done. */
export function dropLiveRun(repoKey: string, taskId: string, path = liveRunsPath()): void {
  try {
    writeLiveRuns(
      path,
      readLiveRuns(path).filter((r) => !(r.repoKey === repoKey && r.taskId === taskId)),
    )
  } catch (err) {
    warn(err)
  }
}

export function loadLiveRuns(path = liveRunsPath()): LiveRun[] {
  return readLiveRuns(path)
}

/**
 * Adds the still-alive external runs to a server runner's status, so the
 * dashboard renders them as worker slots. Runs the server already owns are
 * skipped (a task is claimed once), and stale records whose pid died (a
 * crashed CLI) are pruned from the registry so they do not linger.
 */
export async function mergeLiveRuns(
  status: RunnerStatus,
  runs: LiveRun[],
  path = liveRunsPath(),
  repoKey?: string,
): Promise<RunnerStatus> {
  const alive = runs.filter((r) => pidAlive(r.pid))
  if (alive.length !== runs.length) {
    try {
      writeLiveRuns(path, alive)
    } catch (err) {
      warn(err)
    }
  }
  const live = alive.filter(
    (r) =>
      (repoKey === undefined || r.repoKey === repoKey) &&
      r.taskId !== '' &&
      !status.running.includes(r.taskId),
  )
  if (live.length === 0) return status
  const running = [...status.running, ...live.map((r) => r.taskId)]
  const startedAt: Record<string, number> = { ...status.startedAt }
  const tasks: Record<string, RunnerTask> = { ...status.tasks }
  const resources = { ...status.resources }
  await Promise.all(
    live.map(async (r) => {
      startedAt[r.taskId] = r.startedAt
      tasks[r.taskId] = { title: r.title, harness: r.harness, model: r.model, effort: r.effort }
      resources[r.taskId] = await processTreeStats(r.pid)
    }),
  )
  return { ...status, running, startedAt, tasks, resources }
}
