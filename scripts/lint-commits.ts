// Lints the amagi commits on the current branch that are not on the base yet.
// Usage: bun run scripts/lint-commits.ts [base-branch]
import { lintCommitMessage } from '../packages/core/src/commit-lint.ts'
import { exec } from '../packages/core/src/exec.ts'

const base = process.argv[2] ?? 'main'
let ref: string | null = null
for (const candidate of [`origin/${base}`, base]) {
  const r = await exec(['git', 'rev-parse', '--verify', '--quiet', candidate])
  if (r.exitCode === 0) {
    ref = candidate
    break
  }
}
if (ref === null) {
  console.log(`lint-commits: no ${base} ref, skipping`)
  process.exit(0)
}

const log = await exec(['git', 'log', '--no-merges', '--format=%h%x00%B%x1e', `${ref}..HEAD`])
if (log.exitCode !== 0) {
  console.error(`lint-commits: git log failed: ${log.stderr.trim()}`)
  process.exit(1)
}
let failed = false
for (const entry of log.stdout.split('\x1e')) {
  const [sha, message] = entry.trim().split('\0')
  if (sha === undefined || sha === '' || message === undefined) continue
  for (const error of lintCommitMessage(message)) {
    console.error(`${sha} ${message.split('\n')[0]}: ${error}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
