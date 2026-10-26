import { killTree } from './process.ts'

export type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ExecOptions = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  /** Kills the whole process tree once elapsed and fails the result. */
  timeoutMs?: number
  /** Kills the whole process tree on abort. */
  signal?: AbortSignal
}

export type Exec = (cmd: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

export class CommandError extends Error {
  constructor(
    readonly cmd: readonly string[],
    readonly result: ExecResult,
  ) {
    super(
      `${cmd[0]} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    )
    this.name = 'CommandError'
  }
}

const STREAM_DRAIN_MS = 200

export const exec: Exec = async (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd as string[], {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Killing only the direct child leaves grandchildren holding stdout open,
  // and the reads below would never finish. A descendant that left the tree
  // (double fork) can hold them open anyway, so once killed the reads only
  // drain briefly after the exit.
  let timedOut = false
  const streams = new AbortController()
  let drain: ReturnType<typeof setTimeout> | null = null
  const kill = () => {
    if (proc.exitCode === null && proc.signalCode === null) void killTree(proc.pid)
    void proc.exited.then(() => {
      if (!streams.signal.aborted) drain = setTimeout(() => streams.abort(), STREAM_DRAIN_MS)
    })
  }
  const timer =
    opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true
          kill()
        }, opts.timeoutMs)
  if (opts.signal?.aborted) kill()
  else opts.signal?.addEventListener('abort', kill, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readText(proc.stdout, streams.signal),
      readText(proc.stderr, streams.signal),
      proc.exited,
    ])
    if (timedOut) {
      return {
        exitCode: exitCode === 0 ? 124 : exitCode,
        stdout,
        stderr: `${stderr}\ntimed out after ${opts.timeoutMs}ms\n`,
      }
    }
    return { exitCode, stdout, stderr }
  } finally {
    if (timer) clearTimeout(timer)
    if (drain) clearTimeout(drain)
    streams.abort()
    opts.signal?.removeEventListener('abort', kill)
  }
}

export async function execOk(
  run: Exec,
  cmd: readonly string[],
  opts?: ExecOptions,
): Promise<string> {
  const result = await run(cmd, opts)
  if (result.exitCode !== 0) throw new CommandError(cmd, result)
  return result.stdout
}

export async function readText(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const cancel = () => void reader.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
