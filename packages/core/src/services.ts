import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { readRepoServices } from './config.ts'
import { exec as defaultExec, type Exec } from './exec.ts'

/** Container port the project sees on 127.0.0.1, and the host port its service is published on. */
export type ServiceForward = { port: number; hostPort: number }

const SERVICE_COMMAND_TIMEOUT_MS = 10 * 60_000

/** Host ports handed to each worktree's services; reused so a repeated start is a no-op. */
const hostPorts = new Map<string, Map<number, number>>()

export function serviceProjectName(worktree: string): string {
  return `amagi-${createHash('sha256').update(worktree).digest('hex').slice(0, 12)}`
}

/** The main checkout a worktree belongs to, or null outside a git repository. */
export async function repoRootOf(cwd: string, run: Exec = defaultExec): Promise<string | null> {
  if (!existsSync(cwd)) return null
  const result = await run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
  })
  if (result.exitCode !== 0) return null
  const common = result.stdout.trim()
  return basename(common) === '.git' ? dirname(common) : common
}

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

function serviceEnv(worktree: string, ports: Map<number, number>): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: serviceProjectName(worktree),
    ...Object.fromEntries([...ports].map(([port, host]) => [`AMAGI_PORT_${port}`, String(host)])),
  }
}

async function runServiceCommand(
  action: 'start' | 'stop',
  command: string,
  repoRoot: string,
  env: Record<string, string>,
  run: Exec,
): Promise<string> {
  // Runs outside the sandbox with the operator's container engine, so it is
  // read from and run in the repository checkout: a worktree's compose file
  // is agent-editable and could mount host credentials into a container.
  const result = await run(['sh', '-c', command], {
    cwd: repoRoot,
    env,
    timeoutMs: SERVICE_COMMAND_TIMEOUT_MS,
  })
  if (result.exitCode !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim().slice(-2000)
    throw new Error(`services ${action} failed (exit ${result.exitCode}): ${output}`)
  }
  return `${result.stdout}${result.stderr}`
}

/**
 * Starts the repository's services for one worktree (idempotent while this
 * process keeps its host ports) and returns the forwards its sandboxed setup
 * and checks need, with a log of the start command, its output and the port
 * mapping. No services configured returns no forwards and an empty log.
 */
export async function startServices(
  worktree: string,
  run: Exec = defaultExec,
): Promise<{ forwards: ServiceForward[]; log: string }> {
  const repoRoot = await repoRootOf(worktree, run)
  if (repoRoot === null) return { forwards: [], log: '' }
  const services = readRepoServices(repoRoot)
  if (services.start === null) return { forwards: [], log: '' }
  if (process.platform !== 'linux') {
    throw new Error(
      'repository services need a Linux host: setup and checks reach them through a private network namespace',
    )
  }
  let ports = hostPorts.get(worktree)
  if (ports === undefined || services.ports.some((port) => !ports?.has(port))) {
    ports = new Map(services.ports.map((port) => [port, ports?.get(port) ?? freePort()]))
    hostPorts.set(worktree, ports)
  }
  const env = serviceEnv(worktree, ports)
  const output = await runServiceCommand('start', services.start, repoRoot, env, run)
  const forwards = [...ports].map(([port, hostPort]) => ({ port, hostPort }))
  const log = [
    `$ [services in ${repoRoot}, COMPOSE_PROJECT_NAME=${env.COMPOSE_PROJECT_NAME}] ${services.start}`,
    ...(output.trim() === '' ? [] : [output.trimEnd()]),
    ...forwards.map(
      ({ port, hostPort }) => `services: 127.0.0.1:${port} -> host 127.0.0.1:${hostPort}`,
    ),
    '',
  ].join('\n')
  return { forwards, log }
}

/** Stops a worktree's services before the worktree goes away; a no-op without services. */
export async function stopServices(
  repoRoot: string,
  worktree: string,
  run: Exec = defaultExec,
): Promise<void> {
  const services = readRepoServices(repoRoot)
  if (services.stop === null) return
  await runServiceCommand(
    'stop',
    services.stop,
    repoRoot,
    serviceEnv(worktree, hostPorts.get(worktree) ?? new Map()),
    run,
  )
  hostPorts.delete(worktree)
}
