import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { configHome, hostStateHome, stateHome } from '../../paths.ts'
import { stripHarnessCredentials } from './env.ts'

export function projectCommandEnv(inheritedEnv: NodeJS.ProcessEnv = process.env) {
  const env = Object.fromEntries(Object.entries(inheritedEnv)) as Record<string, string>
  const secretVariables = Object.keys(env).filter((name) =>
    /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITLAB_(ACCESS_)?TOKEN|FORGEJO_TOKEN|GITEA_SERVER_(TOKEN|USER|PASSWORD|OTP)|TEA_TOKEN|DBUS_SESSION_BUS_ADDRESS|GPG_AGENT_INFO)$/.test(
      name,
    ),
  )
  stripHarnessCredentials(env)
  for (const name of secretVariables) env[name] = ''
  env.SSH_AUTH_SOCK = ''
  return env
}

export function sandboxProjectCommand(
  command: string,
  cwd: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
) {
  const env = projectCommandEnv(inheritedEnv)
  return {
    command: sandboxArgv(['sh', '-c', command], undefined, cwd, env, {
      workspaceOnly: true,
    }),
    env,
  }
}

function configuredHelperPaths(cwd?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const git = Bun.which('git')
  if (git === null || !existsSync(git)) return []
  let config: ReturnType<typeof Bun.spawnSync>
  try {
    config = Bun.spawnSync([git, 'config', '--null', '--get-regexp', '^credential\\..*helper$'], {
      ...(cwd === undefined ? {} : { cwd }),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    return []
  }
  if (config.exitCode !== 0) return []
  const paths: string[] = []
  for (const item of (config.stdout?.toString() ?? '').split('\0')) {
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
  options: { workspaceOnly?: boolean } = {},
): string[] {
  if (options.workspaceOnly && cwd === undefined)
    throw new Error('workspace sandbox requires a working directory')
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
      .map((name) => env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ...['XDG_RUNTIME_DIR', 'GNUPGHOME']
      .map((name) => env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    join(home, '.gnupg'),
    ...[join(home, '.config'), configHome()].flatMap((base) =>
      ['gh', 'glab-cli', 'tea'].map((name) => join(base, name)),
    ),
  ]
  const paths = [...new Set(hidden.filter(existsSync).flatMap((p) => [p, realpathSync(p)]))]
  if (process.platform === 'linux') {
    const root = options.workspaceOnly
      ? ['--ro-bind', '/', '/', ...(existsSync('/tmp') ? ['--bind', '/tmp', '/tmp'] : [])]
      : ['--bind', '/', '/']
    const mounts = paths.flatMap((path) =>
      statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path],
    )
    const workspace = options.workspaceOnly ? ['--bind', cwd as string, cwd as string] : []
    return [
      'bwrap',
      ...root,
      '--dev-bind',
      '/dev',
      '/dev',
      '--unshare-pid',
      '--unshare-user',
      '--proc',
      '/proc',
      ...mounts,
      ...workspace,
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
