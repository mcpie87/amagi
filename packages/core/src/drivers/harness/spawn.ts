import { AsyncQueue } from '../../async-queue.ts'
import { errMsg } from '../../errors.ts'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { killTree } from '../../process.ts'
import { acquireSeat } from '../../seat-lock.ts'
import type { AgentOutcome, AgentProcess, AgentStartOptions, AgentUsage } from '../types.ts'
import { harnessEnv } from './env.ts'

/**
 * Renders a harness tool_result payload into a single string: strings pass
 * through, arrays of content blocks join their `text` fields, anything else
 * falls back to JSON. Shared by every translator.
 */
export function renderToolResult(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : JSON.stringify(part),
      )
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}

/**
 * Everything the spawn loop reads off the translator after the stream ends.
 * Each harness's translator class satisfies this structurally.
 */
type Translator = {
  push(raw: unknown): AgentEvent[]
  sessionId: string | null
  summary: string | null
  usage: AgentUsage | null
  ok: boolean
}

export type SpawnAgentOptions = {
  /** Resolved credential seat. Every harness provides it before entering this path. */
  seat?: string
  /** Extra env vars, layered over harnessEnv and opts.env (claude's CLAUDE_EFFORT). */
  env?: Record<string, string>
  /** Emits the closing events once stdout ends, for streams without a terminal message. */
  finalize?: () => AgentEvent[]
  /** Resolved model, read lazily since claude only reports it over the stream. */
  model?: () => string | null
  /** Reasoning effort in effect, or null when unknown. */
  effort?: string | null
  /** Content to pipe into the child's stdin, which is otherwise ignored. */
  stdin?: string
}

/**
 * Shared harness process wiring: Bun.spawn with piped stdout/stderr, the
 * jsonLines translator loop, stderr collection, the done promise, killTree,
 * and the AgentProcess wrapper. Only argv, the translator, and a few
 * harness-specific options differ between codex, claude, and opencode.
 */
export function spawnAgent(
  argv: string[],
  opts: AgentStartOptions,
  translator: Translator,
  options: SpawnAgentOptions = {},
): AgentProcess {
  const seat = options.seat ?? opts.seat
  if (seat === undefined || seat.trim() === '') throw new Error('harness spawn requires a seat')
  const queue = new AsyncQueue<AgentEvent>()
  const abort = new AbortController()
  let child: AgentProcess | undefined
  let cancelled = false

  const done: Promise<AgentOutcome> = (async () => {
    let lease: Awaited<ReturnType<typeof acquireSeat>> | undefined
    try {
      lease = await acquireSeat(seat, {
        signal: abort.signal,
        onWaiting: (message) => queue.push({ kind: 'status', message }),
      })
      if (cancelled) {
        lease.release()
        return cancelledOutcome()
      }
      child = spawnUnlocked(argv, opts, translator, options)
      lease.bind(child.pid)
      for await (const event of child.events()) queue.push(event)
      return await child.done
    } catch (err) {
      if (!cancelled) queue.push({ kind: 'error', message: errMsg(err) })
      return cancelled ? cancelledOutcome() : failedOutcome(errMsg(err))
    } finally {
      lease?.release()
      queue.close()
    }
  })()

  return {
    get pid() {
      return child?.pid ?? 0
    },
    events: () => queue,
    done,
    kill: async () => {
      cancelled = true
      abort.abort()
      await child?.kill()
    },
    get model() {
      return child?.model ?? (options.model ? options.model() : null)
    },
    effort: options.effort ?? null,
  }
}

function cancelledOutcome(): AgentOutcome {
  return { exitCode: 130, ok: false, sessionId: null, summary: null, usage: null, stderr: '' }
}

function failedOutcome(message: string): AgentOutcome {
  return { exitCode: 1, ok: false, sessionId: null, summary: message, usage: null, stderr: message }
}

function spawnUnlocked(
  argv: string[],
  opts: AgentStartOptions,
  translator: Translator,
  options: SpawnAgentOptions,
): AgentProcess {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...harnessEnv(), ...opts.env, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const queue = new AsyncQueue<AgentEvent>()
  const exitCode = proc.exited
  const streams = new AbortController()
  void exitCode.then(() => streams.abort())
  const stderr = readText(proc.stderr, streams.signal)

  const done: Promise<AgentOutcome> = (async () => {
    try {
      for await (const raw of jsonLines(proc.stdout, streams.signal)) {
        for (const event of translator.push(raw)) queue.push(event)
      }
      for (const event of options.finalize?.() ?? []) queue.push(event)
    } catch (err) {
      queue.push({ kind: 'error', message: errMsg(err) })
    } finally {
      queue.close()
    }

    const code = await exitCode
    return {
      exitCode: code,
      ok: translator.ok && code === 0,
      sessionId: translator.sessionId,
      summary: translator.summary,
      usage: translator.usage,
      stderr: await stderr,
    }
  })()

  return {
    pid: proc.pid,
    events: () => queue,
    done,
    kill: async () => {
      await killTree(proc.pid)
    },
    get model() {
      return options.model ? options.model() : null
    },
    effort: options.effort ?? null,
  }
}

async function readText(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const cancel = () => void reader.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}
