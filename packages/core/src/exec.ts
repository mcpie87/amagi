export type ExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type ExecOptions = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
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

export const exec: Exec = async (cmd, opts = {}) => {
  const proc = Bun.spawn(cmd as string[], {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timer =
    opts.timeoutMs === undefined ? null : setTimeout(() => proc.kill('SIGKILL'), opts.timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  } finally {
    if (timer) clearTimeout(timer)
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
