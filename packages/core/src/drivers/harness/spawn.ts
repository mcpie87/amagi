import { AsyncQueue } from '../../async-queue.ts'
import { errMsg } from '../../errors.ts'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { killTree } from '../../process.ts'
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
  /** Extra env vars, layered over harnessEnv and opts.env (claude's CLAUDE_EFFORT). */
  env?: Record<string, string>
  /** Emits the closing events once stdout ends, for streams without a terminal message. */
  finalize?: () => AgentEvent[]
  /** Resolved model, read lazily since claude only reports it over the stream. */
  model?: () => string | null
  /** Reasoning effort in effect, or null when unknown. */
  effort?: string | null
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
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...harnessEnv(), ...opts.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const queue = new AsyncQueue<AgentEvent>()
  const stderr = new Response(proc.stderr).text()

  const done: Promise<AgentOutcome> = (async () => {
    try {
      for await (const raw of jsonLines(proc.stdout)) {
        for (const event of translator.push(raw)) queue.push(event)
      }
      for (const event of options.finalize?.() ?? []) queue.push(event)
    } catch (err) {
      queue.push({ kind: 'error', message: errMsg(err) })
    } finally {
      queue.close()
    }

    const exitCode = await proc.exited
    return {
      exitCode,
      ok: translator.ok && exitCode === 0,
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
