import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { configHome, hostStateHome, stateHome } from '../../paths.ts'

function configuredHelperPaths(cwd?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const git = Bun.which('git')
  if (git === null) return []
  const config = Bun.spawnSync(
    [git, 'config', '--null', '--get-regexp', '^credential\\..*helper$'],
    {
      ...(cwd === undefined ? {} : { cwd }),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (config.exitCode !== 0) return []
  const paths: string[] = []
  for (const item of config.stdout.toString().split('\0')) {
    const newline = item.indexOf('\n')
    if (newline < 0) continue
    let command = item.slice(newline + 1).trim()
    if (command.startsWith('!')) command = command.slice(1).trimStart()
    const quoted = command.match(/^(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)')(?=\s|$)/)
    const first = quoted
      ? (quoted[1]?.replace(/\\(.)/g, '$1') ?? quoted[2] ?? '')
      : (command.match(/^[^\s]+/)?.[0] ?? '')
    let path = first
    if (!isAbsolute(path) && /^[A-Za-z0-9._-]+$/.test(path)) {
      path = Bun.which(`git-credential-${path}`) ?? ''
    }
    if (!isAbsolute(path) || !existsSync(path)) continue
    const real = realpathSync(path)
    if (
      real === realpathSync(git) ||
      ['sh', 'bash', 'zsh', 'env', 'node', 'bun', 'python', 'python3'].includes(basename(real))
    )
      continue
    const systemPath = ['/usr/', '/bin/', '/sbin/', '/nix/store/'].some((prefix) =>
      real.startsWith(prefix),
    )
    if (systemPath && !basename(real).startsWith('git-credential-')) continue
    if (statSync(real).isFile()) paths.push(path)
  }
  return paths
}

/** Prevent the harness from reading the operator's state or forge credentials. */
export function sandboxArgv(
  argv: string[],
  home = homedir(),
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const agent = argv[0] === undefined ? null : Bun.which(argv[0])
  const agentReal = agent === null ? null : realpathSync(agent)
  const helpers = [...configuredHelperPaths(cwd), ...configuredHelperPaths(cwd, env)].filter(
    (path) => realpathSync(path) !== agentReal,
  )
  const hidden = [
    ...helpers,
    ...[stateHome(), hostStateHome()].map((state) => join(state, 'amagi')),
    join(home, '.ssh'),
    join(home, '.git-credentials'),
    ...['SSH_AUTH_SOCK', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR']
      .map((name) => process.env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ...[join(home, '.config'), configHome()].flatMap((base) =>
      ['gh', 'glab-cli', 'tea'].map((name) => join(base, name)),
    ),
  ]
  const paths = [...new Set(hidden.filter(existsSync).flatMap((p) => [p, realpathSync(p)]))]
  if (process.platform === 'linux') {
    const mounts = paths.flatMap((path) =>
      statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path],
    )
    return [
      'bwrap',
      '--bind',
      '/',
      '/',
      '--dev-bind',
      '/dev',
      '/dev',
      '--unshare-pid',
      '--unshare-user',
      '--proc',
      '/proc',
      ...mounts,
      '--',
      ...argv,
    ]
  }
  if (process.platform === 'darwin') {
    const rules = paths.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')
    return [
      'sandbox-exec',
      '-p',
      `(version 1) (allow default) (deny file-read* file-write* ${rules})`,
      ...argv,
    ]
  }
  throw new Error(`agent sandbox is unsupported on ${process.platform}`)
}
