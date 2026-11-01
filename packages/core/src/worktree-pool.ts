import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CommandError, exec as defaultExec, type Exec, execOk } from './exec.ts'
import { branchExists, branchName, type SetupReport, type WorktreeSpec } from './worktree.ts'

type Entry = { path: string; baseSha: string; setupCmd: string; report: SetupReport }
type Reservation = Entry & { branch: string }

type Options = {
  repoRoot: string
  worktreeRoot: string
  baseBranch: string
  remote?: string
  exec?: Exec | undefined
}

const lockfile = /(^|\/)([^/]*lock[^/]*|Cargo\.toml|Gemfile|go\.mod)$/i
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

export class WorktreePool {
  private readonly run: Exec
  private readonly root: string
  private readonly entries: Entry[] = []
  private filling: Promise<void> | null = null
  private target = 0
  private setupCmd = ''
  private stopped = false

  constructor(private readonly opts: Options) {
    this.run = opts.exec ?? defaultExec
    this.root = join(opts.worktreeRoot, '.amagi-pool', digest(opts.repoRoot).slice(0, 16))
  }

  refill(size: number, setupCmd: string | null | undefined): Promise<void> {
    this.setupCmd = setupCmd ?? ''
    this.target = this.setupCmd ? Math.max(0, size) : 0
    if (this.stopped) return Promise.resolve()
    if (this.filling !== null) return this.filling
    this.filling = this.fill()
      .catch((err: unknown) => {
        console.warn(`worktree pool: ${String(err)}`)
      })
      .finally(() => {
        this.filling = null
      })
    return this.filling
  }

  stop(): void {
    this.stopped = true
    this.target = 0
    void this.filling?.then(() => this.removeReady())
    if (this.filling === null) void this.removeReady()
  }

  private async removeReady(): Promise<void> {
    for (const entry of this.entries.splice(0)) {
      const branch = await this.run(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: entry.path })
      if (branch.exitCode === 1) {
        await this.run(['git', 'worktree', 'remove', '--force', entry.path], {
          cwd: this.opts.repoRoot,
        })
      }
    }
  }

  private async setup(path: string, command: string): Promise<SetupReport> {
    const started = Date.now()
    const result = await this.run(['sh', '-c', command], { cwd: path })
    const report = {
      command,
      exitCode: result.exitCode,
      durationMs: Date.now() - started,
      output: `${result.stdout}${result.stderr}`.slice(-4000),
    }
    if (result.exitCode !== 0) throw new CommandError(['sh', '-c', command], result)
    return report
  }

  private async fill(): Promise<void> {
    while (!this.stopped && this.entries.length < this.target) {
      const path = join(this.root, randomUUID())
      let added = false
      try {
        const setupCmd = this.setupCmd
        mkdirSync(this.root, { recursive: true })
        const remoteBase = `${this.opts.remote ?? 'origin'}/${this.opts.baseBranch}`
        const remote = await this.run(['git', 'rev-parse', '--verify', '--quiet', remoteBase], {
          cwd: this.opts.repoRoot,
        })
        const baseSha = (
          await execOk(
            this.run,
            [
              'git',
              'rev-parse',
              '--verify',
              remote.exitCode === 0 ? remoteBase : this.opts.baseBranch,
            ],
            {
              cwd: this.opts.repoRoot,
            },
          )
        ).trim()
        await execOk(this.run, ['git', 'worktree', 'add', '--detach', path, baseSha], {
          cwd: this.opts.repoRoot,
        })
        added = true
        const report = await this.setup(path, setupCmd)
        this.entries.push({ path, baseSha, setupCmd, report })
      } catch (err) {
        if (added)
          await this.run(['git', 'worktree', 'remove', '--force', path], {
            cwd: this.opts.repoRoot,
          })
        throw err
      }
    }
    if (this.stopped) await this.removeReady()
  }

  async take(
    taskId: string,
    title: string,
    baseRef: string,
    setupCmd: string | null | undefined,
    onStarted: (command: string) => void,
    onFinished: (report: SetupReport) => void,
  ): Promise<WorktreeSpec | null> {
    const branch = branchName(taskId, title)
    const marker = join(this.root, `${digest(branch)}.json`)
    let reservation: Reservation | undefined
    let recovered = false
    try {
      const saved = JSON.parse(readFileSync(marker, 'utf8')) as Reservation
      if (
        saved.branch === branch &&
        saved.path.startsWith(`${this.root}/`) &&
        existsSync(saved.path)
      ) {
        reservation = saved
        recovered = true
      }
    } catch {
      /* No reservation exists. */
    }
    if (reservation === undefined) {
      if (existsSync(marker)) return null
      if (!setupCmd) return null
      if (await branchExists(this.run, this.opts.repoRoot, branch)) return null
      const entry = this.entries.shift()
      if (entry === undefined) return null
      reservation = { ...entry, branch }
      writeFileSync(marker, JSON.stringify(reservation), { mode: 0o600, flag: 'wx' })
    }
    const entry = reservation
    const current = await this.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: entry.path,
    })
    if (current.exitCode === 0 && current.stdout.trim() !== branch)
      throw new Error(`reserved worktree is on another branch: ${entry.path}`)
    let needsSetup = recovered || setupCmd !== entry.setupCmd
    if (current.exitCode !== 0) {
      if (await branchExists(this.run, this.opts.repoRoot, branch))
        throw new Error(`branch already exists: ${branch}`)
      const baseSha = (
        await execOk(this.run, ['git', 'rev-parse', '--verify', baseRef], {
          cwd: this.opts.repoRoot,
        })
      ).trim()
      const changed = await execOk(
        this.run,
        ['git', 'diff', '--name-only', '-z', entry.baseSha, baseSha],
        { cwd: this.opts.repoRoot },
      )
      needsSetup ||= changed.split('\0').some((name) => lockfile.test(name))
      await execOk(this.run, ['git', 'switch', '--detach', baseSha], { cwd: entry.path })
      await execOk(this.run, ['git', 'switch', '-c', branch], { cwd: entry.path })
    }
    if (setupCmd) {
      if (needsSetup) {
        onStarted(setupCmd)
        const started = Date.now()
        const result = await this.run(['sh', '-c', setupCmd], { cwd: entry.path })
        onFinished({
          command: setupCmd,
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          output: `${result.stdout}${result.stderr}`.slice(-4000),
        })
        if (result.exitCode !== 0) throw new CommandError(['sh', '-c', setupCmd], result)
      } else {
        onStarted(setupCmd)
        onFinished(entry.report)
      }
    }
    return { path: entry.path, branch }
  }

  recorded(branch: string): void {
    rmSync(join(this.root, `${digest(branch)}.json`), { force: true })
  }
}
