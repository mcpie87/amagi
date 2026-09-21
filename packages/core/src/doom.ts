import type { CheckResult, StoredEvent } from './events.ts'

export type DoomOptions = {
  /** Sliding window (ms) over which repeated tool calls are counted. */
  toolWindowMs: number
  /** Tool calls with an identical signature within the window that trip the guard. */
  toolRepeat: number
  /** Consecutive check rounds sharing one failure signature that trip the guard. */
  checkRounds: number
}

export type DoomSignal = {
  kind: 'tool_repeat' | 'check_repeat' | 'diff_static'
  detail: string
}

/**
 * Normalizes a tool_use call into a "same command/file" signature: the tool
 * name plus its primary operand (command, file_path/path or pattern), with
 * whitespace collapsed so `bun test\n` and `bun test` match. Returns null for
 * calls without a comparable operand (e.g. a bare Task).
 */
export function toolSignature(name: string, input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  const operand =
    (typeof record.command === 'string' ? record.command : undefined) ??
    (typeof record.file_path === 'string' ? record.file_path : undefined) ??
    (typeof record.path === 'string' ? record.path : undefined) ??
    (typeof record.pattern === 'string' ? record.pattern : undefined)
  if (typeof operand !== 'string' || operand.trim() === '') return null
  return `${name}:${operand.replace(/\s+/g, ' ').trim()}`
}

/** The failing commands of one check round, or null when every check passed. */
export function checkFailureSignature(results: CheckResult[]): string | null {
  const failed = results.filter((r) => r.exitCode !== 0)
  if (failed.length === 0) return null
  return failed
    .map((r) => `${r.command}:${r.exitCode}`)
    .sort()
    .join(' | ')
}

/**
 * The event-stream half of the doom-loop guard: catches a busy worker that is
 * not progressing, over the recorded agent stream. Either repeated
 * near-identical tool calls (same command or file) within a sliding window, or
 * several consecutive check rounds with the same failure signature. The
 * worktree-diff half needs git and per-task state, so it lives in the stall
 * watcher, not here.
 */
export function detectDoom(
  events: readonly StoredEvent[],
  nowMs: number,
  opts: DoomOptions,
): DoomSignal | null {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'agent.stream' || event.event.kind !== 'tool_use') continue
    if (event.role !== 'implement') continue
    if (nowMs - event.ts > opts.toolWindowMs) continue
    const sig = toolSignature(event.event.name, event.event.input)
    if (sig === null) continue
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
  }
  for (const [sig, count] of counts) {
    if (count >= opts.toolRepeat) {
      return { kind: 'tool_repeat', detail: `${sig} x${count}` }
    }
  }

  let streak = 0
  let lastSig: string | null = null
  for (const event of events) {
    if (event.type !== 'checks.finished') continue
    const sig = checkFailureSignature(event.results)
    if (sig === null) {
      streak = 0
      lastSig = null
      continue
    }
    if (sig === lastSig) streak++
    else {
      streak = 1
      lastSig = sig
    }
    if (streak >= opts.checkRounds) {
      return { kind: 'check_repeat', detail: `checks failed identically ${streak}x: ${sig}` }
    }
  }
  return null
}
