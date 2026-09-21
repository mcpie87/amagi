const processes = [
  Bun.spawn(['bun', '--watch', 'packages/cli/src/index.ts', 'serve'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'packages/dashboard', 'dev'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
]

let stopping = false

async function stop(exitCode: number): Promise<void> {
  if (stopping) return
  stopping = true
  for (const process of processes) process.kill()
  await Promise.all(processes.map((process) => process.exited))
  process.exit(exitCode)
}

process.on('SIGINT', () => void stop(0))
process.on('SIGTERM', () => void stop(0))

for (const process of processes) {
  void process.exited.then((exitCode) => {
    if (!stopping) void stop(exitCode)
  })
}
