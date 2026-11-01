import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
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
    /^(?:AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|WEB_IDENTITY_TOKEN_FILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|CONTAINER_CREDENTIALS_.*)|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_(?:CONFIG|AUTH_CREDENTIAL_FILE_OVERRIDE)|AZURE_(?:CONFIG_DIR|CLIENT_SECRET|CLIENT_CERTIFICATE_PATH|ACCESS_TOKEN|IDENTITY_TOKEN)|DOCKER_CONFIG|KUBECONFIG|GIT_ASKPASS|GIT_SSH(?:_COMMAND)?|SSH_ASKPASS|GIT_CONFIG_.*)$/.test(
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
    ...credentialEnvs.flatMap((entry) => defaultCredentialCachePaths(entry, cacheHomes)),
    ...globalGitConfigPaths(cwd, withoutGitConfigOverrides(process.env)),
    ...globalGitConfigPaths(cwd, defaultGitEnv),
    ...globalGitConfigPaths(cwd, env),
    ...systemGitConfigPaths(cwd, withoutGitConfigOverrides(process.env)),
    ...systemGitConfigPaths(cwd, defaultGitEnv),
    ...systemGitConfigPaths(cwd, env),
    ...[stateHome(), hostStateHome()].map((state) => join(state, 'amagi')),
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
    ...['SSH_AUTH_SOCK', 'GH_CONFIG_DIR', 'GLAB_CONFIG_DIR']
      .map((name) => env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ...['XDG_RUNTIME_DIR', 'GNUPGHOME']
      .map((name) => env[name])
      .filter((path): path is string => path !== undefined && isAbsolute(path)),
    ...[...homes.map((path) => join(path, '.config')), configHome()].flatMap((base) =>
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
    const unset = sensitiveEnvironmentNames(env).flatMap((name) => ['--unsetenv', name])
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
      ...workspace,
      ...mounts,
      ...unset,
      '--',
      ...argv,
    ]
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
