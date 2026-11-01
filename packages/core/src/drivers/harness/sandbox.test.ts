import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxArgv, sandboxExecProfile } from './sandbox.ts'

test('builds one macOS deny rule per secret path and blocks Keychain lookup', () => {
  const profile = sandboxExecProfile(['/home/test/.aws', '/home/test/.netrc'])
  expect(profile).toContain('(deny mach-lookup (global-name "com.apple.securityd"))')
  expect(profile).toContain('(deny file-read* file-write* (subpath "/home/test/.aws"))')
  expect(profile).toContain('(deny file-read* file-write* (subpath "/home/test/.netrc"))')
  expect(profile).not.toContain('(subpath "/home/test/.aws") (subpath')
})

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'limits project checks to a writable worktree and temporary files',
  () => {
    const root = mkdtempSync(join(process.cwd(), '.amagi-check-sandbox-'))
    const worktree = join(root, 'worktree')
    const outside = join(root, 'outside')
    mkdirSync(worktree)
    writeFileSync(outside, 'unchanged')
    const sandbox = sandboxArgv(
      [
        process.execPath,
        '-e',
        `
        const fs = require('node:fs');
        try { fs.writeFileSync(${JSON.stringify(outside)}, 'changed'); process.exit(1); }
        catch (error) { if (!['EROFS', 'EACCES'].includes(error.code)) throw error; }
        fs.writeFileSync(${JSON.stringify(join(worktree, 'result'))}, 'ok');
      `,
      ],
      root,
      worktree,
      {},
      { workspaceOnly: true },
    )
    try {
      const result = Bun.spawnSync(sandbox, { stderr: 'pipe' })
      expect(result.exitCode).toBe(0)
      expect(readFileSync(outside, 'utf8')).toBe('unchanged')
      expect(readFileSync(join(worktree, 'result'), 'utf8')).toBe('ok')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('rejects credential values in repository Git config and included files', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-credentials-'))
  const repo = join(root, 'repo')
  const config = join(root, 'included')
  mkdirSync(repo)
  const init = Bun.spawnSync(['git', 'init', '-q', repo], { stderr: 'pipe' })
  expect(init.exitCode).toBe(0)
  try {
    for (const [kind, value] of [
      ['credential', 'synthetic-password'],
      ['include', 'Authorization: Bearer synthetic-token'],
      ['includeIf', 'Authorization: Bearer synthetic-token'],
    ]) {
      if (kind === 'include' || kind === 'includeIf') {
        const include =
          kind === 'include' ? '[include]\n' : `[includeIf "gitdir/i:${join(repo, '.git')}"]\n`
        writeFileSync(config, `[http]\n  extraHeader = ${value}\n`)
        writeFileSync(join(repo, '.git', 'config'), `${include}  path = ${config}\n`)
      } else {
        writeFileSync(join(repo, '.git', 'config'), `[credential]\n  password = ${value}\n`)
      }
      expect(() => sandboxArgv([process.execPath, '--version'], root, repo, process.env)).toThrow(
        'repository Git config contains credentials that cannot be isolated',
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('allows ordinary repository and linked-worktree Git config', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-config-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const init = Bun.spawnSync(['git', 'init', '-q', repo], { stderr: 'pipe' })
  expect(init.exitCode).toBe(0)
  try {
    writeFileSync(
      join(repo, '.git', 'config'),
      `[core]\n  worktree = ${repo}\n[branch "main"]\n  remote = origin\n[remote "origin"]\n  url = https://example.test/repo.git\n[credential]\n  helper = store\n`,
    )
    expect(() =>
      sandboxArgv([process.execPath, '--version'], root, repo, process.env),
    ).not.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'linux')(
  'rejects repository Git config using Linux keyring helpers',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-libsecret-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)

    try {
      for (const helper of ['libsecret', 'manager', 'manager-core']) {
        writeFileSync(
          join(repo, '.git', 'config'),
          `[credential]\n  helper = ${helper}\n  credentialStore = secretservice\n`,
        )
        expect(() => sandboxArgv([process.execPath, '--version'], root, repo, process.env)).toThrow(
          'repository Git config contains credentials that cannot be isolated',
        )
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks HTTP cookie, client key, and certificate paths from Git config scopes',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-http-secret-paths-'))
    const repo = join(root, 'repo')
    const globalConfig = join(root, 'global-config')
    const includedConfig = join(root, 'included-config')
    const cookieFile = join(root, 'cookies')
    const sslKey = join(root, 'client.key')
    const sslCert = join(root, 'client.pem')
    const sslCertTarget = join(root, 'client.pem.real')
    mkdirSync(repo)
    expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
    writeFileSync(cookieFile, 'session=synthetic-secret')
    writeFileSync(sslKey, 'private key')
    writeFileSync(sslCertTarget, 'certificate and possible private key')
    symlinkSync(sslCertTarget, sslCert)
    writeFileSync(globalConfig, `[http]\n  cookieFile = ${cookieFile}\n`)
    writeFileSync(includedConfig, `[http]\n  sslCert = ${sslCert}\n`)
    writeFileSync(
      join(repo, '.git', 'config'),
      `[include]\n  path = ${includedConfig}\n[http]\n  sslKey = ${sslKey}\n  lowSpeedLimit = 10\n`,
    )

    try {
      const args = sandboxArgv([process.execPath, '--version'], root, repo, {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
      })
      for (const path of [cookieFile, sslKey, sslCert, sslCertTarget])
        expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${path}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test('rejects credential-bearing remote URLs and included custom helpers without exposing values', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-secret-config-'))
  const repo = join(root, 'repo')
  const included = join(root, 'included')
  mkdirSync(repo)
  const init = Bun.spawnSync(['git', 'init', '-q', repo], { stderr: 'pipe' })
  expect(init.exitCode).toBe(0)
  try {
    const configPath = join(repo, '.git', 'config')
    const genericError = 'repository Git config contains credentials that cannot be isolated'
    for (const config of [
      '[remote "origin"]\n  url = https://user:synthetic-token@example.test/repo.git\n',
      `[include]\n  path = ${included}\n`,
    ]) {
      if (config.startsWith('[include]')) {
        writeFileSync(included, '[credential]\n  helper = !custom-helper --token=synthetic-token\n')
        writeFileSync(configPath, config)
      } else {
        writeFileSync(configPath, config)
      }
      let message = ''
      try {
        sandboxArgv([process.execPath, '--version'], root, repo, process.env)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe(genericError)
      expect(message).not.toContain('synthetic-token')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects local SSH commands without exposing external key paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-ssh-command-'))
  const repo = join(root, 'repo')
  const key = join(root, 'external-private-key')
  mkdirSync(repo)
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
  writeFileSync(key, 'private key')
  writeFileSync(
    join(repo, '.git', 'config'),
    `[core]\n  sshCommand = ssh -i ${key} -o IdentitiesOnly=yes\n`,
  )
  try {
    let message = ''
    try {
      sandboxArgv([process.execPath, '--version'], root, repo, process.env)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('repository Git config contains credentials that cannot be isolated')
    expect(message).not.toContain(key)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects local askpass commands without exposing helper paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-askpass-'))
  const repo = join(root, 'repo')
  const helper = join(root, 'external-askpass-helper')
  const included = join(root, 'included')
  mkdirSync(repo)
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0)
  writeFileSync(helper, '#!/bin/sh\nprintf secret\n', { mode: 0o700 })
  writeFileSync(included, `[core]\n  askPass = ${helper}\n`)
  writeFileSync(join(repo, '.git', 'config'), `[include]\n  path = ${included}\n`)
  try {
    let message = ''
    try {
      sandboxArgv([process.execPath, '--version'], root, repo, process.env)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('repository Git config contains credentials that cannot be isolated')
    expect(message).not.toContain(helper)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects credential-bearing HTTP proxies and URL rewrites, including nested includes', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-local-git-proxy-config-'))
  const repo = join(root, 'repo')
  const include = join(root, 'included')
  const nestedInclude = join(root, 'nested-included')
  mkdirSync(repo)
  const init = Bun.spawnSync(['git', 'init', '-q', repo], { stderr: 'pipe' })
  expect(init.exitCode).toBe(0)
  try {
    const configPath = join(repo, '.git', 'config')
    const genericError = 'repository Git config contains credentials that cannot be isolated'
    for (const config of [
      '[http]\n  proxy = https://user:proxy-secret@proxy.example.test\n',
      '[url "https://user:rewrite-secret@mirror.example.test/"]\n  insteadOf = https://example.test/\n',
      `[include]\n  path = ${include}\n`,
    ]) {
      if (config.startsWith('[include]')) {
        writeFileSync(include, `[include]\n  path = ${nestedInclude}\n`)
        writeFileSync(
          nestedInclude,
          '[url "https://user:nested-secret@mirror.example.test/"]\n  insteadOf = https://example.test/\n',
        )
        writeFileSync(configPath, config)
      } else {
        writeFileSync(configPath, config)
      }
      let message = ''
      try {
        sandboxArgv([process.execPath, '--version'], root, repo, process.env)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe(genericError)
      expect(message).not.toContain('proxy-secret')
      expect(message).not.toContain('rewrite-secret')
      expect(message).not.toContain('nested-secret')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'hides state and exposes only the shim, agent config and current run',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-isolation-test-'))
    const previous = process.env.XDG_STATE_HOME
    const previousHome = process.env.HOME
    process.env.XDG_STATE_HOME = root
    process.env.HOME = root
    const state = join(root, 'amagi')
    const runtime = join(root, 'amagi-agent')
    const run = join(runtime, 'runs', 'task-1')
    for (const path of [
      join(runtime, 'shim'),
      join(runtime, 'env'),
      run,
      join(state, 'repos'),
      join(root, '.ssh'),
      join(root, '.config', 'tea'),
    ]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(join(state, 'repos', 'secret'), 'private')
    writeFileSync(join(state, 'operator-session.json'), 'private')
    writeFileSync(join(root, '.ssh', 'id'), 'private')
    writeFileSync(join(root, '.git-credentials'), 'private')
    writeFileSync(join(root, '.config', 'tea', 'config.yml'), 'private')
    writeFileSync(join(runtime, 'shim', 'shim'), 'available')
    const sandbox = sandboxArgv(
      [
        process.execPath,
        '-e',
        `
        const fs = require('node:fs');
        if (fs.existsSync(${JSON.stringify(join(state, 'repos', 'secret'))})) process.exit(1);
        if (fs.existsSync(${JSON.stringify(join(state, 'operator-session.json'))})) process.exit(2);
        if (fs.existsSync(${JSON.stringify(join(root, '.ssh', 'id'))})) process.exit(4);
        try {
          if (fs.readFileSync(${JSON.stringify(join(root, '.git-credentials'))}, 'utf8') !== '') process.exit(5);
        } catch (error) {
          if (error.code !== 'EACCES') throw error;
        }
        if (fs.existsSync(${JSON.stringify(join(root, '.config', 'tea', 'config.yml'))})) process.exit(6);
        if (fs.readdirSync('/proc').filter((name) => /^\\d+$/.test(name)).length > 2) process.exit(7);
        const nested = Bun.spawnSync(['bwrap', '--bind', '/', '/', '--dev-bind', '/dev', '/dev',
          '--unshare-user', '--unshare-pid', '--proc', '/proc', '--', process.execPath, '-e',
          ${JSON.stringify(`if (require('node:fs').existsSync(${JSON.stringify(join(state, 'repos', 'secret'))})) process.exit(8)`)}]);
        if (nested.exitCode !== 0) process.exit(8);
        if (fs.readFileSync(${JSON.stringify(join(runtime, 'shim', 'shim'))}, 'utf8') !== 'available') process.exit(3);
        fs.writeFileSync(${JSON.stringify(join(run, 'rejected'))}, 'ok');
      `,
      ],
      root,
    )
    try {
      const result = Bun.spawnSync(sandbox, { stderr: 'pipe' })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      expect(readFileSync(join(run, 'rejected'), 'utf8')).toBe('ok')
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = previous
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'masks a configured custom credential helper, including direct and explicit Git calls',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-helper-'))
    const oldGlobal = process.env.GIT_CONFIG_GLOBAL
    const helper = join(root, 'helper')
    const config = join(root, 'gitconfig')
    writeFileSync(helper, '#!/bin/sh\nprintf "username=test\\npassword=synthetic-secret\\n"\n', {
      mode: 0o700,
    })
    writeFileSync(config, `[credential]\n  helper = ${helper}\n`)
    process.env.GIT_CONFIG_GLOBAL = config
    try {
      const input = 'protocol=https\nhost=example.test\n\n'
      const before = Bun.spawnSync(['git', 'credential', 'fill'], {
        stdin: new TextEncoder().encode(input),
        env: process.env,
      })
      expect({
        status: before.exitCode,
        out: before.stdout.toString(),
        err: before.stderr.toString(),
      }).toMatchObject({ status: 0, out: expect.stringContaining('synthetic-secret') })
      const command = `
        const input = new TextEncoder().encode(${JSON.stringify(input)});
        for (const args of [
          ['git', 'credential', 'fill'],
          ['git', '-c', 'credential.helper=', '-c', ${JSON.stringify(`credential.helper=${helper}`)}, 'credential', 'fill'],
          [${JSON.stringify(helper)}, 'get'],
        ]) {
          try {
            const result = Bun.spawnSync(args, { stdin: input, stderr: 'pipe' });
            if (result.stdout.toString().includes('synthetic-secret')) process.exit(1);
            if (result.exitCode === 0) process.exit(2);
          } catch (error) {
            if (error.code !== 'EACCES') throw error;
          }
        }
        const git = Bun.spawnSync(['git', '--version']);
        if (git.exitCode !== 0) process.exit(3);
      `
      const result = Bun.spawnSync(sandboxArgv([process.execPath, '-e', command], root, root), {
        stderr: 'pipe',
        env: process.env,
      })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
    } finally {
      if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = oldGlobal
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'inspects the harness environment override for helpers',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-helper-env-'))
    try {
      const helper = join(root, 'helper')
      const config = join(root, 'gitconfig')
      writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      writeFileSync(config, `[credential]\n  helper = python3 ${helper}\n`)
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_SSH: '/private/ssh-wrapper',
        GIT_SSH_COMMAND: 'ssh -i /private/key',
      })
      expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${helper}`)
      expect(args.join('\0')).toContain('--unsetenv\0GIT_CONFIG_GLOBAL')
      expect(args.join('\0')).toContain('--unsetenv\0GIT_SSH')
      expect(args.join('\0')).toContain('--unsetenv\0GIT_SSH_COMMAND')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'resolves named credential helpers using the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-helper-path-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const helper = join(bin, 'git-credential-custom')
      const config = join(root, 'gitconfig')
      writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      writeFileSync(config, '[credential]\n  helper = custom\n')
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        PATH: bin,
      })
      expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${helper}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'resolves shell credential helpers using the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-shell-helper-path-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const helper = join(bin, 'custom-helper')
      const config = join(root, 'gitconfig')
      writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      writeFileSync(config, '[credential]\n  helper = !custom-helper\n')
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        PATH: bin,
      })
      expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${helper}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'resolves env-wrapped shell credential helpers using the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-env-shell-helper-path-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const helper = join(bin, 'custom-helper')
      const config = join(root, 'gitconfig')
      writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      for (const value of [
        '!env custom-helper',
        '!env FOO=bar custom-helper',
        '!env -- custom-helper',
        "!env sh -c 'custom-helper'",
        "!env FOO=bar sh -c 'env BAZ=qux sh -c custom-helper'",
      ]) {
        writeFileSync(config, `[credential]\n  helper = ${value}\n`)
        const args = sandboxArgv([process.execPath, '--version'], root, root, {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          PATH: bin,
        })
        expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${helper}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'fails closed when an env-wrapped shell helper is missing from the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-env-shell-helper-missing-'))
    try {
      const config = join(root, 'gitconfig')
      writeFileSync(config, '[credential]\n  helper = !env FOO=bar missing-custom\n')
      expect(() =>
        sandboxArgv([process.execPath, '--version'], root, root, {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          PATH: '',
        }),
      ).toThrow('configured Git credential helper is not resolvable: missing-custom')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'fails closed when a shell credential helper is missing from the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-shell-helper-missing-'))
    try {
      const config = join(root, 'gitconfig')
      writeFileSync(config, '[credential]\n  helper = !missing-custom\n')
      expect(() =>
        sandboxArgv([process.execPath, '--version'], root, root, {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          PATH: '',
        }),
      ).toThrow('configured Git credential helper is not resolvable: missing-custom')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'fails closed when a named credential helper is missing from the supplied PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-helper-missing-'))
    try {
      const config = join(root, 'gitconfig')
      writeFileSync(config, '[credential]\n  helper = missing-custom\n')
      expect(() =>
        sandboxArgv([process.execPath, '--version'], root, root, {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          PATH: '',
        }),
      ).toThrow('configured Git credential helper is not resolvable: missing-custom')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks credential paths referenced by environment variables before unsetting them',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-env-credentials-'))
    try {
      const aws = join(root, 'aws')
      const docker = join(root, 'docker')
      const kube1 = join(root, 'kube-one')
      const kube2 = join(root, 'kube-two')
      const google = join(root, 'google.json')
      mkdirSync(aws)
      mkdirSync(docker)
      const gcloud = join(root, 'gcloud')
      const azure = join(root, 'azure')
      mkdirSync(gcloud)
      mkdirSync(azure)
      for (const file of [join(aws, 'credentials'), join(aws, 'config'), kube1, kube2, google])
        writeFileSync(file, 'secret')
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        AWS_SHARED_CREDENTIALS_FILE: join(aws, 'credentials'),
        AWS_CONFIG_FILE: join(aws, 'config'),
        CLOUDSDK_CONFIG: join(root, 'gcloud'),
        AZURE_CONFIG_DIR: join(root, 'azure'),
        DOCKER_CONFIG: docker,
        KUBECONFIG: `${kube1}:${kube2}`,
        GOOGLE_APPLICATION_CREDENTIALS: google,
      })
      const joined = args.join('\0')
      expect(joined).toContain(`--ro-bind\0/dev/null\0${join(aws, 'credentials')}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${join(aws, 'config')}`)
      expect(joined).toContain(`--tmpfs\0${docker}`)
      expect(joined).toContain(`--tmpfs\0${gcloud}`)
      expect(joined).toContain(`--tmpfs\0${azure}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${kube1}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${kube2}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${google}`)
      for (const name of [
        'AWS_SHARED_CREDENTIALS_FILE',
        'AWS_CONFIG_FILE',
        'CLOUDSDK_CONFIG',
        'AZURE_CONFIG_DIR',
        'DOCKER_CONFIG',
        'KUBECONFIG',
        'GOOGLE_APPLICATION_CREDENTIALS',
      ]) {
        expect(joined).toContain(`--unsetenv\0${name}`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'masks custom credential stores even when they live inside the worktree',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-store-'))
    const store = join(root, 'credential-store')
    const config = join(root, 'gitconfig')
    writeFileSync(store, 'https://user:store-secret@example.test\n')
    writeFileSync(config, `[credential]\n  helper = store --file=${store}\n`)
    try {
      const command = `
        const fs = require('node:fs');
        try {
          if (fs.readFileSync(${JSON.stringify(store)}, 'utf8') !== '') process.exit(1);
        } catch (error) {
          if (error.code !== 'EACCES') throw error;
        }
        if (process.env.GIT_CONFIG_GLOBAL) process.exit(2);
      `
      const result = Bun.spawnSync(
        sandboxArgv(
          [process.execPath, '-e', command],
          root,
          root,
          {
            ...process.env,
            GIT_CONFIG_GLOBAL: config,
          },
          { workspaceOnly: true },
        ),
        { stderr: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: config } },
      )
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'masks Git config files referenced by environment variables inside the worktree',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-config-'))
    const globalConfig = join(root, 'global.gitconfig')
    const systemConfig = join(root, 'system.gitconfig')
    writeFileSync(globalConfig, '[http]\n  extraHeader = Authorization: Basic inline-secret\n')
    writeFileSync(
      systemConfig,
      '[credential]\n  username = inline-user\n  password = inline-secret\n',
    )
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
    }
    try {
      const command = `
        const fs = require('node:fs');
        for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
          if (process.env[name] !== undefined) process.exit(1);
        }
        for (const path of [${JSON.stringify(globalConfig)}, ${JSON.stringify(systemConfig)}]) {
          try {
            if (fs.readFileSync(path, 'utf8') !== '') process.exit(2);
          } catch (error) {
            if (error.code !== 'EACCES') throw error;
          }
        }
      `
      const args = sandboxArgv([process.execPath, '-e', command], root, root, env, {
        workspaceOnly: true,
      })
      const joined = args.join('\0')
      for (const [name, path] of [
        ['GIT_CONFIG_GLOBAL', globalConfig],
        ['GIT_CONFIG_SYSTEM', systemConfig],
      ]) {
        expect(joined).toContain(`--ro-bind\0/dev/null\0${path}`)
        expect(joined).toContain(`--unsetenv\0${name}`)
      }
      const result = Bun.spawnSync(args, { stderr: 'pipe', env })
      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks default and XDG Git configs, including the agent config symlink target',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-config-paths-'))
    const hostXdg = join(root, 'host-xdg')
    const agentXdg = join(root, 'agent-xdg')
    const hostGitConfig = join(hostXdg, 'git', 'config')
    const agentGitDir = join(agentXdg, 'git')
    const defaultConfig = join(root, '.gitconfig')
    const previousXdg = process.env.XDG_CONFIG_HOME
    const previousHome = process.env.HOME
    mkdirSync(join(hostXdg, 'git'), { recursive: true })
    mkdirSync(agentGitDir, { recursive: true })
    writeFileSync(hostGitConfig, '[credential]\n  username = inline-user\n')
    writeFileSync(defaultConfig, '[credential]\n  username = inline-user\n')
    symlinkSync(hostGitConfig, join(agentGitDir, 'config'))
    try {
      process.env.XDG_CONFIG_HOME = hostXdg
      process.env.HOME = root
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: agentXdg,
      })
      const joined = args.join('\0')
      for (const path of [defaultConfig, hostGitConfig])
        expect(joined).toContain(`--ro-bind\0/dev/null\0${path}`)
      expect(joined).not.toContain(`--ro-bind\0/dev/null\0${join(agentGitDir, 'config')}`)
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdg
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks included files from explicit and default global Git configs',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-config-includes-'))
    const childHome = join(root, 'home')
    const explicitGlobal = join(root, 'explicit.gitconfig')
    const defaultGlobal = join(childHome, '.gitconfig')
    const included = join(root, 'included.gitconfig')
    const includedTarget = join(root, 'included-target.gitconfig')
    mkdirSync(childHome)
    writeFileSync(includedTarget, '[credential]\n  password = hidden-value\n')
    symlinkSync(includedTarget, included)
    const globalContents = `[include]\n  path = ${included}\n`
    writeFileSync(explicitGlobal, globalContents)
    writeFileSync(defaultGlobal, globalContents)
    try {
      const explicitEnv = { ...process.env, GIT_CONFIG_GLOBAL: explicitGlobal }
      const defaultEnv: NodeJS.ProcessEnv = { ...process.env, HOME: childHome }
      delete defaultEnv.GIT_CONFIG_GLOBAL
      for (const env of [explicitEnv, defaultEnv]) {
        const args = sandboxArgv([process.execPath, '--version'], childHome, childHome, env)
        const joined = args.join('\0')
        expect(joined).toContain(`--ro-bind\0/dev/null\0${included}`)
        expect(joined).toContain(`--ro-bind\0/dev/null\0${includedTarget}`)
        expect(joined).not.toContain('hidden-value')
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks default global includes when GIT_CONFIG_GLOBAL selects another config',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-config-default-include-'))
    const childHome = join(root, 'home')
    const overrideGlobal = join(root, 'override.gitconfig')
    const defaultGlobal = join(childHome, '.gitconfig')
    const overrideInclude = join(root, 'override-included.gitconfig')
    const defaultInclude = join(root, 'default-included.gitconfig')
    mkdirSync(childHome)
    for (const path of [overrideInclude, defaultInclude])
      writeFileSync(path, '[credential]\n  password = hidden-value\n')
    writeFileSync(overrideGlobal, `[include]\n  path = ${overrideInclude}\n`)
    writeFileSync(defaultGlobal, `[include]\n  path = ${defaultInclude}\n`)
    try {
      const args = sandboxArgv([process.execPath, '--version'], childHome, childHome, {
        ...process.env,
        HOME: childHome,
        GIT_CONFIG_GLOBAL: overrideGlobal,
      })
      const joined = args.join('\0')
      for (const path of [overrideGlobal, overrideInclude, defaultGlobal, defaultInclude])
        expect(joined).toContain(`--ro-bind\0/dev/null\0${path}`)
      expect(joined).not.toContain('hidden-value')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks the active system Git config symlink target without exposing its contents',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-system-git-config-'))
    const config = join(root, 'system-config')
    const target = join(root, 'system-config-target')
    writeFileSync(target, '[credential]\n  password = inline-secret\n')
    symlinkSync(target, config)
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_SYSTEM: config,
      })
      const joined = args.join('\0')
      expect(joined).toContain(`--ro-bind\0/dev/null\0${target}`)
      expect(joined).not.toContain('inline-secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks explicitly referenced system Git config even when GIT_CONFIG_NOSYSTEM is set',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-system-git-config-nosystem-'))
    const systemConfig = join(root, 'system-config')
    writeFileSync(systemConfig, '[credential]\n  password = inline-secret\n')
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: systemConfig,
      })
      const joined = args.join('\0')
      expect(joined).toContain(`--ro-bind\0/dev/null\0${systemConfig}`)
      expect(joined).toContain('--unsetenv\0GIT_CONFIG_NOSYSTEM')
      expect(joined).toContain('--unsetenv\0GIT_CONFIG_SYSTEM')
      expect(joined).not.toContain('inline-secret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks included files from the system Git config, including symlink targets',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-system-git-config-includes-'))
    const systemConfig = join(root, 'system-config')
    const included = join(root, 'included.gitconfig')
    const includedTarget = join(root, 'included-target.gitconfig')
    writeFileSync(includedTarget, '[credential]\n  password = hidden-value\n')
    symlinkSync(includedTarget, included)
    writeFileSync(systemConfig, `[include]\n  path = ${included}\n`)
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_SYSTEM: systemConfig,
      })
      const joined = args.join('\0')
      expect(joined).toContain(`--ro-bind\0/dev/null\0${included}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${includedTarget}`)
      expect(joined).not.toContain('hidden-value')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'expands HOME and XDG_CONFIG_HOME in credential store file paths',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-store-vars-'))
    const xdg = join(root, 'xdg')
    const homeStore = join(root, 'home-store')
    const xdgStore = join(xdg, 'credential-store')
    const config = join(root, 'gitconfig')
    writeFileSync(homeStore, 'https://user:secret@example.test\n')
    mkdirSync(xdg)
    writeFileSync(xdgStore, 'https://user:secret@example.test\n')
    writeFileSync(
      config,
      `[credential "home"]\n  helper = store --file=\${HOME}/home-store\n[credential "xdg"]\n  helper = store --file=$XDG_CONFIG_HOME/credential-store\n`,
    )
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: config,
        XDG_CONFIG_HOME: xdg,
      })
      const joined = args.join('\0')
      expect(joined).toContain(`--ro-bind\0/dev/null\0${homeStore}`)
      expect(joined).toContain(`--ro-bind\0/dev/null\0${xdgStore}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')('masks credential stores wrapped by env and Git', () => {
  const root = mkdtempSync(join(tmpdir(), 'amagi-wrapped-git-store-'))
  const bin = join(root, 'bin')
  const envStore = join(root, 'env-store')
  const gitStore = join(root, 'git-store')
  const config = join(root, 'gitconfig')
  mkdirSync(bin)
  writeFileSync(join(bin, 'store'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  writeFileSync(envStore, 'https://user:secret@example.test\n')
  writeFileSync(gitStore, 'https://user:secret@example.test\n')
  writeFileSync(
    config,
    '[credential "env"]\n  helper = !env store --file=$HOME/env-store\n' +
      '[credential "git"]\n  helper = !env git credential-store --file=$HOME/git-store\n',
  )
  try {
    const args = sandboxArgv([process.execPath, '--version'], root, root, {
      ...process.env,
      HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_GLOBAL: config,
    })
    const joined = args.join('\0')
    expect(joined).toContain(`--ro-bind\0/dev/null\0${envStore}`)
    expect(joined).toContain(`--ro-bind\0/dev/null\0${gitStore}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'linux')(
  'masks default Git credential cache directories for host and child environments',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-cache-defaults-'))
    const hostHome = join(root, 'host-home')
    const childHome = join(root, 'child-home')
    const hostCache = join(root, 'host-cache')
    const childCache = join(root, 'child-cache')
    const previousHome = process.env.HOME
    const previousCache = process.env.XDG_CACHE_HOME
    for (const path of [
      join(hostHome, '.git-credential-cache'),
      join(childHome, '.git-credential-cache'),
      join(hostCache, 'git', 'credential'),
      join(childCache, 'git', 'credential'),
    ])
      mkdirSync(path, { recursive: true })
    try {
      process.env.HOME = hostHome
      process.env.XDG_CACHE_HOME = hostCache
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: childHome,
        XDG_CACHE_HOME: childCache,
      })
      const joined = args.join('\0')
      for (const path of [
        join(hostHome, '.git-credential-cache'),
        join(childHome, '.git-credential-cache'),
        join(hostCache, 'git', 'credential'),
        join(childCache, 'git', 'credential'),
      ])
        expect(joined).toContain(`--tmpfs\0${path}`)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousCache === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = previousCache
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks custom Git credential cache sockets from direct and shell helpers',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-cache-custom-'))
    const directSocket = join(root, 'direct.sock')
    const wrappedSocket = join(root, 'wrapped.sock')
    const config = join(root, 'gitconfig')
    writeFileSync(directSocket, '')
    writeFileSync(wrappedSocket, '')
    writeFileSync(
      config,
      `[credential "direct"]\n  helper = cache --socket=${directSocket}\n` +
        `[credential "wrapped"]\n  helper = !git credential-cache --socket=$HOME/wrapped.sock get\n`,
    )
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: config,
      })
      const joined = args.join('\0')
      for (const path of [directSocket, wrappedSocket])
        expect(joined).toContain(`--ro-bind\0/dev/null\0${path}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'masks the parent directory of a fresh custom Git credential cache socket',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-cache-missing-'))
    const socket = join(root, 'fresh.sock')
    const config = join(root, 'gitconfig')
    writeFileSync(config, `[credential]\n  helper = !git credential-cache --socket=${socket} get\n`)
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
      })
      expect(args.join('\0')).toContain(`--tmpfs\0${root}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'does not mask a shared temporary directory for a missing cache socket',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-cache-shared-parent-'))
    const socket = join(tmpdir(), 'amagi-missing-cache.sock')
    const config = join(root, 'gitconfig')
    writeFileSync(config, `[credential]\n  helper = !git credential-cache --socket=${socket} get\n`)
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
      })
      expect(args.join('\0')).not.toContain(`--tmpfs\0${tmpdir()}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'does not mask broad home or cache roots for missing sockets',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-git-cache-broad-roots-'))
    const home = join(root, 'home')
    const cache = join(root, 'cache')
    const config = join(root, 'gitconfig')
    mkdirSync(home)
    mkdirSync(cache)
    writeFileSync(
      config,
      `[credential "home"]\n  helper = cache --socket=${join(home, 'fresh.sock')}\n` +
        `[credential "xdg"]\n  helper = cache --socket=${join(cache, 'fresh.sock')}\n`,
    )
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: cache,
        GIT_CONFIG_GLOBAL: config,
      })
      const joined = args.join('\0')
      expect(joined).not.toContain(`--tmpfs\0${home}`)
      expect(joined).not.toContain(`--tmpfs\0${cache}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'uses the child HOME for credential paths and masks its home credentials',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-child-home-'))
    const childHome = join(root, 'child-home')
    const helper = join(childHome, 'bin', 'custom-helper')
    const store = join(childHome, 'credential-store')
    const config = join(root, 'gitconfig')
    mkdirSync(join(childHome, 'bin'), { recursive: true })
    mkdirSync(join(childHome, '.ssh'), { recursive: true })
    mkdirSync(join(childHome, '.config', 'tea'), { recursive: true })
    writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(store, 'https://user:secret@example.test\n')
    writeFileSync(join(childHome, '.gitconfig'), '[credential]\n  username = secret\n')
    writeFileSync(join(childHome, '.ssh', 'id'), 'secret')
    writeFileSync(join(childHome, '.git-credentials'), 'https://user:secret@example.test\n')
    writeFileSync(join(childHome, '.config', 'tea', 'config.yml'), 'secret')
    writeFileSync(
      config,
      `[credential]\n  helper = store --file=$HOME/credential-store\n  helper = !~/bin/custom-helper\n`,
    )
    try {
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        HOME: childHome,
        GIT_CONFIG_GLOBAL: config,
      })
      const joined = args.join('\0')
      for (const path of [
        store,
        helper,
        join(childHome, '.gitconfig'),
        join(childHome, '.ssh'),
        join(childHome, '.git-credentials'),
        join(childHome, '.config', 'tea'),
      ]) {
        expect(joined).toContain(path)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'resolves nested shell credential executables through PATH',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-nested-shell-helper-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      const helper = join(bin, 'custom-helper')
      const config = join(root, 'gitconfig')
      writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      writeFileSync(config, "[credential]\n  helper = !sh -c 'custom-helper'\n")
      const args = sandboxArgv([process.execPath, '--version'], root, root, {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        PATH: bin,
      })
      expect(args.join('\0')).toContain(`--ro-bind\0/dev/null\0${helper}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== 'linux')(
  'fails closed on compound nested shell credential commands',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-nested-shell-helper-opaque-'))
    try {
      const config = join(root, 'gitconfig')
      writeFileSync(config, "[credential]\n  helper = !sh -c 'custom-helper; another-helper'\n")
      expect(() =>
        sandboxArgv([process.execPath, '--version'], root, root, {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          PATH: '',
        }),
      ).toThrow('configured Git credential helper is not resolvable:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
