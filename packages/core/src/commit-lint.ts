import { COMMIT_FOOTER_PREFIX } from './footer.ts'

const SUBJECT = /^\[[^\]\s]+\] \S/
const FOOTER = new RegExp(`^${COMMIT_FOOTER_PREFIX}( · .+)?$`)
/** The per-file `Changes:` list older amagi commits carried. */
const FILE_STAT = /^- `[^`]+` (\+\d+ -\d+|binary)$/

/**
 * A commit amagi made: a `[task-id]` subject or the amagi footer. Human and
 * agent-authored commits carry neither, so the lint leaves them alone.
 */
export function isAmagiCommit(message: string): boolean {
  const lines = message.trim().split('\n')
  return SUBJECT.test(lines[0] ?? '') || lines.some((line) => FOOTER.test(line.trim()))
}

/**
 * What is wrong with an amagi commit message, empty when it is well formed or
 * not an amagi commit: a `[task-id] title` subject, a blank line, a summary of
 * the change, and the amagi footer as the last line. The changed files are
 * left to the diff.
 */
export function lintCommitMessage(message: string): string[] {
  if (!isAmagiCommit(message)) return []
  const lines = message.trim().split('\n')
  const errors: string[] = []
  if (!SUBJECT.test(lines[0] ?? '')) errors.push('subject must start with `[task-id] `')
  if (lines.length > 1 && lines[1]?.trim() !== '') {
    errors.push('subject must be followed by a blank line')
  }
  if (!FOOTER.test(lines.at(-1)?.trim() ?? '')) {
    errors.push(`last line must be the \`${COMMIT_FOOTER_PREFIX}\` footer`)
  }
  if (lines.slice(1, -1).every((line) => line.trim() === '')) {
    errors.push('body must summarize the change')
  }
  if (lines.some((line) => line.trim() === 'Changes:' || FILE_STAT.test(line.trim()))) {
    errors.push('body must not list the changed files; the diff shows them')
  }
  return errors
}
