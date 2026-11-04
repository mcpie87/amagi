import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { cacheHome, configHome, expandTilde, hostStateHome, stateHome } from '../../paths.ts'
import { type ServiceForward, startServices } from '../../services.ts'
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

/**
 * Setup or check command for a worktree, sandboxed in a private network on
 * Linux. Starts the repository's services first and forwards their ports in;
 * `servicesLog` is what that start printed, for the command's output.
 */
export async function sandboxProjectCommand(
  command: string,
  cwd: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
) {
  const services = await startServices(cwd)
  const env = projectCommandEnv(inheritedEnv)
  // uvx needs a writable tool dir; the default one under the read-only data
  // dir holds executables the host runs, so it must not become writable.
  env.UV_TOOL_DIR ??= join(
    env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : join(env.HOME ?? homedir(), '.cache'),
    'uv',
    'check-tools',
  )
  return {
    command: sandboxArgv(['sh', '-c', command], undefined, cwd, env, {
      workspaceOnly: true,
      ...(process.platform === 'linux' ? { network: services.forwards } : {}),
    }),
    env,
    servicesLog: services.log,
  }
}

function configuredHelperPaths(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  home = env.HOME ?? homedir(),
): string[] {
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
    const shellCommand = command.startsWith('!')
    if (shellCommand) command = command.slice(1).trimStart()
    const commands = shellCommand ? nestedShellCommands(command) : [command]
    const candidates = commands.flatMap((nested) => helperPathReferences(nested, cwd, home))
    for (const nested of commands) {
      const words = helperWords(nested)
      const commandIndex = helperCommandIndex(words)
      const first = words[commandIndex] ?? ''
      const executableName = first.startsWith('~/') ? join(home, first.slice(2)) : first
      if (shellCommand && first && !shellBuiltins.has(first) && !isAbsolute(executableName)) {
        if (['sh', 'bash', 'zsh', 'dash'].includes(first)) continue
        const pathEnv = { PATH: env.PATH ?? process.env.PATH ?? '' }
        const executable = Bun.which(executableName, pathEnv)
        if (executable === null)
          throw new Error(`configured Git credential helper is not resolvable: ${first}`)
        candidates.push(executable)
      }
      if (!shellCommand && !isAbsolute(first) && /^[A-Za-z0-9._-]+$/.test(first)) {
        if (
          first !== 'store' &&
          first !== 'git-credential-store' &&
          first !== 'cache' &&
          first !== 'git-credential-cache'
        ) {
          const pathEnv = { PATH: env.PATH ?? process.env.PATH ?? '' }
          const named = Bun.which(`git-credential-${first}`, pathEnv)
          const executable = Bun.which(first, pathEnv)
          if (named !== null) candidates.push(named)
          else if (executable !== null) candidates.push(executable)
          else throw new Error(`configured Git credential helper is not resolvable: ${first}`)
        }
      }
    }
    for (const path of candidates) {
      if (!existsSync(path)) continue
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
  }
  return paths
}

function nestedShellCommands(command: string): string[] {
  const commands = [command]
  for (let i = 0; i < commands.length; i++) {
    const words = helperWords(commands[i] ?? '')
    const shellIndex = helperCommandIndex(words)
    const shell = basename(words[shellIndex] ?? '')
    if (!['sh', 'bash', 'zsh', 'dash'].includes(shell)) continue
    const cFlag = words.indexOf('-c', shellIndex + 1)
    const nested = cFlag < 0 ? undefined : words[cFlag + 1]
    if (cFlag >= 0 && !nested)
      throw new Error('configured Git credential helper shell command cannot be resolved')
    if (nested) {
      if (/[;&|\n`]|\$\(/.test(nested))
        throw new Error('configured Git credential helper shell command cannot be resolved')
      commands.push(nested)
    }
  }
  return commands
}

function helperCommandIndex(words: string[]): number {
  let index = words[0] === 'command' || words[0] === 'exec' ? 1 : 0
  if (words[index] !== 'env') return index
  index++
  while (index < words.length) {
    const option = words[index] ?? ''
    if (option === '--') return index + 1
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(option)) {
      index++
      continue
    }
    if (option === '-i' || option === '--ignore-environment') {
      index++
      continue
    }
    if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir') {
      index += 2
      continue
    }
    if (option.startsWith('--unset=') || option.startsWith('--chdir=')) {
      index++
      continue
    }
    break
  }
  return index
}

const shellBuiltins = new Set([
  ':',
  '.',
  'alias',
  'bg',
  'break',
  'cd',
  'command',
  'continue',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'jobs',
  'kill',
  'printf',
  'pwd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unalias',
  'unset',
])

function helperWords(command: string): string[] {
  const words: string[] = []
  const pattern = /(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+))/g
  for (const match of command.matchAll(pattern)) {
    words.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1'))
  }
  return words
}

function helperPathReferences(command: string, cwd?: string, home = homedir()): string[] {
  return helperWords(command).flatMap((word) => {
    const candidate = word.replace(/[;,|&)}]+$/, '')
    if (!candidate || candidate.startsWith('-')) return []
    const expanded = candidate.startsWith('~/') ? join(home, candidate.slice(2)) : candidate
    if (isAbsolute(expanded)) return [expanded]
    if (expanded.startsWith('./') || expanded.startsWith('../'))
      return [resolve(cwd ?? process.cwd(), expanded)]
    return []
  })
}

function expandCredentialPath(path: string, env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env.XDG_CONFIG_HOME ?? join(home, '.config')
  const xdgCache = env.XDG_CACHE_HOME ?? join(home, '.cache')
  const expanded = path
    .replace(/\$\{HOME\}|\$HOME/g, home)
    .replace(/\$\{XDG_CONFIG_HOME\}|\$XDG_CONFIG_HOME/g, xdg)
    .replace(/\$\{XDG_CACHE_HOME\}|\$XDG_CACHE_HOME/g, xdgCache)
  return expanded === '~'
    ? home
    : expanded.startsWith('~/')
      ? join(home, expanded.slice(2))
      : expanded
}

function configuredCredentialStorePaths(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] {
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
    for (const nested of nestedShellCommands(command)) {
      const words = helperWords(nested)
      let storeIndex = helperCommandIndex(words)
      if (
        basename(words[storeIndex] ?? '') === 'git' &&
        words[storeIndex + 1] === 'credential-store'
      )
        storeIndex++
      if (
        basename(words[storeIndex] ?? '') !== 'store' &&
        basename(words[storeIndex] ?? '') !== 'git-credential-store' &&
        !(
          basename(words[storeIndex] ?? '') === 'credential-store' &&
          words[storeIndex - 1] === 'git'
        )
      )
        continue
      for (let i = storeIndex + 1; i < words.length; i++) {
        const word = words[i]
        const path = word?.startsWith('--file=')
          ? word.slice('--file='.length)
          : word === '--file'
            ? words[++i]
            : undefined
        if (path === undefined || path === '') continue
        const expanded = expandCredentialPath(path, env, home)
        paths.push(isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded))
      }
    }
  }
  return paths
}

function configuredCredentialCachePaths(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
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
    for (const nested of nestedShellCommands(command)) {
      const words = helperWords(nested)
      let commandIndex = helperCommandIndex(words)
      if (
        basename(words[commandIndex] ?? '') === 'git' &&
        words[commandIndex + 1] === 'credential-cache'
      )
        commandIndex++
      const executable = basename(words[commandIndex] ?? '')
      if (
        executable !== 'cache' &&
        executable !== 'git-credential-cache' &&
        executable !== 'credential-cache'
      )
        continue

      for (let i = commandIndex + 1; i < words.length; i++) {
        const word = words[i] ?? ''
        const socket = word.startsWith('--socket=')
          ? word.slice('--socket='.length)
          : word === '--socket'
            ? words[++i]
            : undefined
        if (socket === undefined || socket === '') {
          if (word === '--socket' || word.startsWith('--socket='))
            throw new Error('configured Git credential cache socket cannot be resolved')
          continue
        }
        const expanded = expandCredentialPath(socket, env, home)
        const path = isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded)
        if (existsSync(path)) {
          paths.push(path)
          continue
        }
        const parent = dirname(path)
        const sharedParents = new Set([
          '/tmp',
          '/var/tmp',
          '/private/tmp',
          '/run',
          '/var/run',
          tmpdir(),
          home,
          env.XDG_CACHE_HOME ?? join(home, '.cache'),
        ])
        if (
          !sharedParents.has(resolve(parent)) &&
          existsSync(parent) &&
          statSync(parent).isDirectory()
        )
          paths.push(parent)
      }
    }
  }
  return paths
}

function defaultCredentialCachePaths(env: NodeJS.ProcessEnv, homes: string[]): string[] {
  return [
    ...homes.flatMap((home) => [
      join(home, '.git-credential-cache'),
      join(home, '.cache', 'git', 'credential'),
    ]),
    ...(env.XDG_CACHE_HOME ? [join(env.XDG_CACHE_HOME, 'git', 'credential')] : []),
  ]
}

function systemGitConfigPaths(cwd: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const git = Bun.which('git')
  if (git === null || !existsSync(git)) return []
  let config: ReturnType<typeof Bun.spawnSync>
  try {
    config = Bun.spawnSync(
      [git, 'config', '--system', '--includes', '--show-origin', '--name-only', '--list', '--null'],
      {
        ...(cwd === undefined ? {} : { cwd }),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
  } catch {
    return []
  }
  if (config.exitCode !== 0) return []

  const records = (config.stdout?.toString() ?? '').split('\0')
  return records.flatMap((record, index) =>
    index % 2 === 0 && record.startsWith('file:') ? [record.slice('file:'.length)] : [],
  )
}

function configuredHttpCredentialPaths(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const git = Bun.which('git')
  if (git === null || !existsSync(git)) return []
  let config: ReturnType<typeof Bun.spawnSync>
  try {
    config = Bun.spawnSync(
      [
        git,
        'config',
        '--includes',
        '--path',
        '--show-origin',
        '--null',
        '--get-regexp',
        '^http\\..*',
      ],
      {
        ...(cwd === undefined || !existsSync(cwd) ? {} : { cwd }),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
  } catch {
    throw new Error('Git HTTP credential paths cannot be isolated')
  }
  if (config.exitCode === 1) return []
  if (config.exitCode !== 0) throw new Error('Git HTTP credential paths cannot be isolated')

  const records = (config.stdout?.toString() ?? '').split('\0')
  const paths: string[] = []
  for (let i = 0; i + 1 < records.length; i += 2) {
    const separator = records[i + 1]?.indexOf('\n') ?? -1
    if (separator < 0) throw new Error('Git HTTP credential paths cannot be isolated')
    const key = records[i + 1]?.slice(0, separator) ?? ''
    const value = records[i + 1]?.slice(separator + 1) ?? ''
    if (!/^http\.(?:.*\.)?(cookiefile|sslkey|sslcert)$/.test(key) || !value.trim()) continue
    const expanded = expandCredentialPath(value.trim(), env, home)
    paths.push(isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded))
  }
  return paths
}

function withoutGitConfigOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_CONFIG_')))
}

function assertNoLocalGitCredentials(cwd: string | undefined, env: NodeJS.ProcessEnv): void {
  if (cwd === undefined) return
  const git = Bun.which('git')
  if (git === null || !existsSync(git)) return
  const options = { cwd, env, stdout: 'pipe' as const, stderr: 'pipe' as const }
  let repository: ReturnType<typeof Bun.spawnSync>
  try {
    repository = Bun.spawnSync([git, 'rev-parse', '--git-dir'], options)
  } catch {
    return
  }
  if (repository.exitCode !== 0) return

  let config: ReturnType<typeof Bun.spawnSync>
  try {
    config = Bun.spawnSync(
      [
        git,
        'config',
        '--local',
        '--includes',
        '--null',
        '--show-origin',
        '--get-regexp',
        '^(credential\\.password|credential\\..*\\.password|credential(\\..*)?\\.helper|core\\.(sshcommand|askpass)|http\\..*(extraheader|proxy)|remote\\..*\\.(url|pushurl)|url\\..*\\.insteadof)$',
      ],
      options,
    )
  } catch {
    throw new Error('repository Git config contains credentials that cannot be isolated')
  }
  if (config.exitCode === 1) return
  if (config.exitCode !== 0)
    throw new Error('repository Git config contains credentials that cannot be isolated')

  const records = (config.stdout?.toString() ?? '').split('\0')
  for (let i = 0; i + 1 < records.length; i += 2) {
    const separator = records[i + 1]?.indexOf('\n') ?? -1
    if (separator < 0) {
      throw new Error('repository Git config contains credentials that cannot be isolated')
    }
    const key = records[i + 1]?.slice(0, separator) ?? ''
    const value = records[i + 1]?.slice(separator + 1) ?? ''
    if (
      key === 'credential.password' ||
      /^credential\..*\.password$/.test(key) ||
      /^http\..*extraheader$/.test(key)
    ) {
      if (value)
        throw new Error('repository Git config contains credentials that cannot be isolated')
      continue
    }
    if (/^credential(\..*)?\.helper$/.test(key)) {
      if (
        value &&
        (!safeCredentialHelpers.has(value.trim()) ||
          (process.platform === 'linux' &&
            ['libsecret', 'manager', 'manager-core'].includes(value.trim())))
      )
        throw new Error('repository Git config contains credentials that cannot be isolated')
      continue
    }
    if (/^(http\..*proxy|remote\..*\.(url|pushurl))$/.test(key) && hasHttpUserinfo(value))
      throw new Error('repository Git config contains credentials that cannot be isolated')
    if ((key === 'core.sshcommand' || key === 'core.askpass') && value.trim())
      throw new Error('repository Git config contains credentials that cannot be isolated')
    const rewriteBase = /^url\.(.*)\.insteadof$/.exec(key)?.[1]
    if (rewriteBase !== undefined && (hasHttpUserinfo(rewriteBase) || hasHttpUserinfo(value)))
      throw new Error('repository Git config contains credentials that cannot be isolated')
  }
}

const safeCredentialHelpers = new Set([
  'cache',
  'libsecret',
  'manager',
  'manager-core',
  'osxkeychain',
  'store',
  'wincred',
])

function hasHttpUserinfo(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.username || url.password)
    )
  } catch {
    return false
  }
}

function globalGitConfigPaths(cwd: string | undefined, env: NodeJS.ProcessEnv): string[] {
  const git = Bun.which('git')
  if (git === null || !existsSync(git)) return []
  let config: ReturnType<typeof Bun.spawnSync>
  try {
    config = Bun.spawnSync(
      [git, 'config', '--global', '--includes', '--show-origin', '--name-only', '--list', '--null'],
      {
        ...(cwd === undefined ? {} : { cwd }),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
  } catch {
    return []
  }
  if (config.exitCode !== 0) return []

  const records = (config.stdout?.toString() ?? '').split('\0')
  return records.flatMap((record, index) =>
    index % 2 === 0 && record.startsWith('file:') ? [record.slice('file:'.length)] : [],
  )
}

function sensitiveEnvironmentNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter((name) =>
    /^(?:AMAGI_(?:DB|REGISTRY)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|WEB_IDENTITY_TOKEN_FILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_CREDENTIALS_.*)|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_(?:CONFIG|AUTH_CREDENTIAL_FILE_OVERRIDE)|AZURE_(?:CONFIG_DIR|CLIENT_SECRET|CLIENT_CERTIFICATE_PATH|ACCESS_TOKEN|IDENTITY_TOKEN)|DOCKER_CONFIG|KUBECONFIG|GIT_ASKPASS|GIT_SSH(?:_COMMAND)?|SSH_ASKPASS|GIT_CONFIG_.*)$/.test(
      name,
    ),
  )
}

function environmentCredentialPaths(
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  home: string,
): string[] {
  const singlePaths = [
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'CLOUDSDK_CONFIG',
    'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
    'AZURE_CONFIG_DIR',
    'AZURE_CLIENT_CERTIFICATE_PATH',
    'DOCKER_CONFIG',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
  ]
  const values = singlePaths.flatMap((name) => (env[name] ? [env[name] as string] : []))
  if (env.KUBECONFIG) values.push(...env.KUBECONFIG.split(':').filter(Boolean))
  return values.map((value) => {
    const expanded =
      value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value
    return resolve(cwd ?? process.cwd(), expanded)
  })
}

/**
 * Empty read-only file bound over hidden files on Linux. Lives under the
 * state dir, which is itself hidden, so the agent cannot rewrite it.
 */
export function emptyMaskPath(): string {
  return join(stateHome(), 'amagi', 'sandbox-empty')
}

/** Address inside a private network that pasta answers DNS on, relaying to the host resolver. */
const SANDBOX_DNS = '169.254.1.1'

/**
 * resolv.conf for a private network: the host's search and options lines,
 * with the nameserver swapped for the pasta relay, since a loopback resolver
 * such as systemd-resolved is unreachable from another network namespace.
 */
function sandboxResolvConf(): string | null {
  if (!existsSync('/etc/resolv.conf')) return null
  const kept = readFileSync('/etc/resolv.conf', 'utf8')
    .split('\n')
    .filter((line) => /^(search|domain|options)\s/.test(line))
  const content = [`nameserver ${SANDBOX_DNS}`, ...kept, ''].join('\n')
  const path = join(stateHome(), 'amagi', 'sandbox-resolv.conf')
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) {
    mkdirSync(dirname(path), { recursive: true })
    const staged = `${path}.${process.pid}`
    writeFileSync(staged, content, { mode: 0o444 })
    renameSync(staged, path)
  }
  return path
}

/**
 * Runs a bwrap argv that waits on fd 4 after reporting its pid on fd 3, attaches
 * pasta to its network namespace, then releases it. pasta gives the sandbox
 * outbound access and forwards each `port:hostPort` from its loopback to the
 * host's; every other host loopback port stays unreachable. Explicit `none`
 * specs matter: pasta's default `auto` mirrors every host listener inside.
 */
const NETNS_LAUNCHER = `set -eu
if ! command -v pasta >/dev/null 2>&1; then
  echo 'amagi: pasta (from passt) is not on PATH; setup and checks need it for their private network' >&2
  exit 127
fi
forwards=$1
shift
dir=$(mktemp -d)
sandbox=
child=
# Exiting closes the block fifo and EOF releases the sandbox, network or not.
# Kill its pid namespace init directly: killing the outer bwrap leaves it running.
trap 'if [ -n "$child" ]; then kill -KILL "$child" 2>/dev/null || true; fi; if [ -n "$sandbox" ]; then kill "$sandbox" 2>/dev/null || true; fi; rm -rf "$dir"' EXIT
mkfifo "$dir/info" "$dir/block"
"$@" 3>"$dir/info" 4<"$dir/block" &
sandbox=$!
exec 5<"$dir/info" 6>"$dir/block"
child=$(sed -n 's/.*"child-pid": *\\([0-9]*\\).*/\\1/p' <&5 | head -n1)
set --
for forward in $forwards; do set -- "$@" -T "$forward"; done
if [ $# -eq 0 ]; then set -- -T none; fi
pasta --config-net --quiet --no-map-gw -t none -u none -U none --dns-forward ${SANDBOX_DNS} "$@" "$child"
printf x >&6
exec 5<&- 6>&-
status=0
wait "$sandbox" || status=$?
sandbox=
child=
exit "$status"
`

/** Prevent the harness from reading the operator's state or forge credentials. */
export function sandboxArgv(
  argv: string[],
  home = homedir(),
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { workspaceOnly?: boolean; network?: readonly ServiceForward[] } = {},
): string[] {
  if (options.workspaceOnly && cwd === undefined)
    throw new Error('workspace sandbox requires a working directory')
  assertNoLocalGitCredentials(cwd, env)
  const effectiveHome = env.HOME ?? home
  const defaultGitEnv = withoutGitConfigOverrides(env)
  const helperDiscoveryEnv = {
    ...defaultGitEnv,
    PATH: [defaultGitEnv.PATH, process.env.PATH].filter(Boolean).join(delimiter),
  }
  const homes = [...new Set([homedir(), home, effectiveHome])]
  const credentialEnvs = [process.env, defaultGitEnv, env]
  const cacheHomes = [
    ...new Set([
      ...homes,
      ...credentialEnvs
        .map((entry) => entry.HOME)
        .filter((path): path is string => path !== undefined),
    ]),
  ]
  const agent = argv[0] === undefined ? null : Bun.which(argv[0])
  const agentReal = agent === null ? null : realpathSync(agent)
  const helpers = [
    ...configuredHelperPaths(cwd),
    ...configuredHelperPaths(cwd, helperDiscoveryEnv, effectiveHome),
    ...configuredHelperPaths(cwd, env, effectiveHome),
  ].filter((path) => realpathSync(path) !== agentReal)
  const hidden = [
    ...helpers,
    ...environmentCredentialPaths(env, cwd, effectiveHome),
    ...homes.map((path) => join(path, '.gitconfig')),
    ...new Set(
      [
        join(
          process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? homedir(), '.config'),
          'git',
          'config',
        ),
        join(env.XDG_CONFIG_HOME ?? join(effectiveHome, '.config'), 'git', 'config'),
      ].flatMap((path) => {
        if (!existsSync(path)) return []
        const real = realpathSync(path)
        return [real === path ? path : real]
      }),
    ),
    ...configuredCredentialStorePaths(cwd, process.env, process.env.HOME ?? homedir()),
    ...configuredCredentialStorePaths(cwd, defaultGitEnv, effectiveHome),
    ...configuredCredentialStorePaths(cwd, env, effectiveHome),
    ...credentialEnvs.flatMap((entry) =>
      configuredHttpCredentialPaths(cwd, entry, entry.HOME ?? effectiveHome),
    ),
    ...credentialEnvs.flatMap((entry) =>
      configuredCredentialCachePaths(cwd, entry, entry.HOME ?? effectiveHome),
    ),
    ...credentialEnvs.flatMap((entry) =>
      ['AMAGI_DB', 'AMAGI_REGISTRY'].flatMap((name) => {
        const path = entry[name]
        return path ? [resolve(expandTilde(path))] : []
      }),
    ),
    ...credentialEnvs.flatMap((entry) => defaultCredentialCachePaths(entry, cacheHomes)),
    ...globalGitConfigPaths(cwd, withoutGitConfigOverrides(process.env)),
    ...globalGitConfigPaths(cwd, defaultGitEnv),
    ...globalGitConfigPaths(cwd, env),
    ...systemGitConfigPaths(cwd, withoutGitConfigOverrides(process.env)),
    ...systemGitConfigPaths(cwd, defaultGitEnv),
    ...systemGitConfigPaths(cwd, env),
    ...[stateHome(), hostStateHome()].map((state) => join(state, 'amagi')),
    ...credentialEnvs.flatMap((entry) => {
      const entryHome = entry.HOME ?? effectiveHome
      const xdgState =
        entry.XDG_STATE_HOME && isAbsolute(entry.XDG_STATE_HOME)
          ? entry.XDG_STATE_HOME
          : join(entryHome, '.local', 'state')
      const devState =
        entry.AMAGI_DEV_HOME && isAbsolute(entry.AMAGI_DEV_HOME)
          ? [join(entry.AMAGI_DEV_HOME, 'state', 'amagi')]
          : []
      return [join(xdgState, 'amagi'), ...devState]
    }),
    ...homes.flatMap((path) => [
      join(path, '.ssh'),
      join(path, '.git-credentials'),
      join(path, '.netrc'),
      ...['.aws', '.azure', '.docker', '.kube'].map((name) => join(path, name)),
      join(path, '.config', 'gcloud'),
      join(path, '.config', 'containers', 'auth.json'),
      join(path, 'Library', 'Keychains'),
      join(path, '.gnupg'),
    ]),
    ...credentialEnvs.flatMap((entry) =>
      ['SSH_AUTH_SOCK', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR']
        .map((name) => entry[name])
        .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ),
    ...['XDG_RUNTIME_DIR', 'GNUPGHOME']
      .map((name) => env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ...[...homes.map((path) => join(path, '.config')), configHome()].flatMap((base) =>
      ['gh', 'glab-cli', 'tea'].map((name) => join(base, name)),
    ),
    ...(process.platform === 'linux' && typeof process.getuid === 'function'
      ? [join('/run/user', String(process.getuid()))]
      : []),
  ]
  const paths = [
    ...new Set(
      hidden.flatMap((path) => (existsSync(path) ? [path, realpathSync(path)] : [resolve(path)])),
    ),
  ]
  if (process.platform === 'linux') {
    const root = options.workspaceOnly
      ? ['--ro-bind', '/', '/', ...(existsSync('/tmp') ? ['--bind', '/tmp', '/tmp'] : [])]
      : ['--bind', '/', '/']
    const mask = emptyMaskPath()
    if (!existsSync(mask)) {
      mkdirSync(dirname(mask), { recursive: true })
      writeFileSync(mask, '', { mode: 0o444 })
    }
    // Not /dev/null: bwrap binds are nodev, so a masked file would fail with
    // EACCES and libgit2 (nix flakes) refuses to open a repo over an
    // unreadable ~/.gitconfig.
    const mounts = paths
      .filter(existsSync)
      .flatMap((path) =>
        statSync(path).isDirectory() ? ['--tmpfs', path] : ['--ro-bind', mask, path],
      )
    const cache =
      env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
        ? env.XDG_CACHE_HOME
        : join(effectiveHome, '.cache')
    // nix and package managers fail on a read-only cache; amagi's own cache
    // holds the other tasks' worktrees, so it stays hidden.
    const workspace = options.workspaceOnly
      ? [
          ...(existsSync(cache) ? ['--bind', cache, cache] : []),
          ...[join(cacheHome(), 'amagi'), join(cache, 'amagi')].flatMap((path) =>
            existsSync(path) ? ['--tmpfs', path] : [],
          ),
          '--bind',
          cwd as string,
          cwd as string,
        ]
      : []
    const unset = sensitiveEnvironmentNames(env).flatMap((name) => ['--unsetenv', name])
    const resolv = options.network === undefined ? null : sandboxResolvConf()
    const network =
      options.network === undefined
        ? []
        : [
            '--unshare-net',
            '--die-with-parent',
            '--info-fd',
            '3',
            '--block-fd',
            '4',
            // bwrap cannot mount over a symlink, and /etc/resolv.conf usually is one.
            ...(resolv === null ? [] : ['--ro-bind', resolv, realpathSync('/etc/resolv.conf')]),
          ]
    const bwrap = [
      'bwrap',
      ...root,
      '--dev-bind',
      '/dev',
      '/dev',
      '--unshare-pid',
      '--unshare-user',
      ...network,
      '--proc',
      '/proc',
      ...workspace,
      ...mounts,
      ...unset,
      '--',
      ...argv,
    ]
    if (options.network === undefined) return bwrap
    const forwards = options.network.map(({ port, hostPort }) => `${port}:${hostPort}`).join(' ')
    return ['sh', '-c', NETNS_LAUNCHER, 'amagi-netns', forwards, ...bwrap]
  }
  if (process.platform === 'darwin') {
    const unset = sensitiveEnvironmentNames(env).flatMap((name) => ['-u', name])
    return [
      'sandbox-exec',
      '-p',
      sandboxExecProfile(paths),
      '/usr/bin/env',
      ...unset,
      '--',
      ...argv,
    ]
  }
  throw new Error(`agent sandbox is unsupported on ${process.platform}`)
}

export function sandboxExecProfile(paths: string[]): string {
  return `(version 1) (allow default) (deny mach-lookup (global-name "com.apple.securityd")) ${paths
    .map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`)
    .join(' ')}`
}
