import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxArgv } from './sandbox.ts'

test.skipIf(process.platform !== 'linux' || Bun.which('bwrap') === null)(
  'hides state and exposes only the shim, agent config and current run',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'amagi-isolation-test-'))
    const previous = process.env.XDG_STATE_HOME
    process.env.XDG_STATE_HOME = root
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
      rmSync(root, { recursive: true, force: true })
    }
  },
)
