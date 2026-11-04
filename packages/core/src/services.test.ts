import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Exec, type ExecOptions, exec } from './exec.ts'
import { serviceProjectName, startServices, stopServices } from './services.ts'

test.skipIf(process.platform !== 'linux')(
  'runs service commands from the repository checkout with stable per-worktree ports',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'amagi-services-')))
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktree')
    try {
      mkdirSync(join(repo, '.amagi'), { recursive: true })
      writeFileSync(
        join(repo, '.amagi', 'config.toml'),
        '[services]\nstart = "up"\nstop = "down"\nports = [5432]\n',
      )
      await exec(['git', 'init', '-q', repo])
      await exec(
        [
          'git',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'init',
        ],
        { cwd: repo },
      )
      await exec(['git', 'worktree', 'add', '-q', '--detach', worktree], { cwd: repo })

      const calls: { cmd: readonly string[]; opts: ExecOptions }[] = []
      const run: Exec = async (cmd, opts = {}) => {
        if (cmd[0] === 'git') return exec(cmd, opts)
        calls.push({ cmd, opts })
        return { exitCode: 0, stdout: '', stderr: 'Container db Healthy\n' }
      }

      const first = await startServices(worktree, run)
      const again = await startServices(worktree, run)
      await stopServices(repo, worktree, run)

      expect(again).toEqual(first)
      expect(first.forwards).toEqual([{ port: 5432, hostPort: expect.any(Number) }])
      const hostPort = first.forwards[0]?.hostPort
      expect(first.log).toBe(
        [
          `$ [services in ${repo}, COMPOSE_PROJECT_NAME=${serviceProjectName(worktree)}] up`,
          'Container db Healthy',
          `services: 127.0.0.1:5432 -> host 127.0.0.1:${hostPort}`,
          '',
        ].join('\n'),
      )
      expect(calls.map(({ cmd, opts }) => [cmd[2], opts.cwd])).toEqual([
        ['up', repo],
        ['up', repo],
        ['down', repo],
      ])
      expect(calls[0]?.opts.env).toEqual({
        COMPOSE_PROJECT_NAME: serviceProjectName(worktree),
        AMAGI_PORT_5432: String(hostPort),
      })
      expect(calls[2]?.opts.env?.COMPOSE_PROJECT_NAME).toBe(serviceProjectName(worktree))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('fails setup and checks with the start command output', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'amagi-services-fail-')))
  try {
    mkdirSync(join(root, '.amagi'), { recursive: true })
    writeFileSync(join(root, '.amagi', 'config.toml'), '[services]\nstart = "up"\nstop = "down"\n')
    await exec(['git', 'init', '-q', root])
    const run: Exec = async (cmd, opts) =>
      cmd[0] === 'git' ? exec(cmd, opts) : { exitCode: 1, stdout: '', stderr: 'no such image' }
    const started = startServices(root, run)
    if (process.platform === 'linux')
      await expect(started).rejects.toThrow('services start failed (exit 1): no such image')
    else await expect(started).rejects.toThrow('repository services need a Linux host')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
