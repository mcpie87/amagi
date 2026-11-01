import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { configHome, hostStateHome, stateHome } from '../../paths.ts'

/** Prevent the harness from reading the operator's state or forge credentials. */
export function sandboxArgv(argv: string[], home = homedir()): string[] {
  const hidden = [
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
