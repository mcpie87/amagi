import { AsyncQueue } from '../../async-queue.ts'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { killTree } from '../../process.ts'
import type {
  AgentOutcome,
  AgentProcess,
  AgentStartOptions,
  AgentUsage,
  Harness,
} from '../types.ts'

type ToolState = {
  status?: string
  input?: unknown
  output?: unknown
}

type Part = {
  type?: string
  tool?: string
  callID?: string
  state?: ToolState
  text?: string
  tokens?: { input?: number; output?: number }
  cost?: number
}

type OpencodeMessage = {
  type?: string
  sessionID?: string
  part?: Part
}

function renderToolResult(output: unknown): string {
  if (typeof output === 'string') return output
  return JSON.stringify(output ?? '')
}

/**
 * Turns opencode's `run --format json` dialect (step_start/tool_use/step_finish/
 * text events, each carrying a `part`) into the shared AgentEvent union. Split
 * out from the spawn so the recorded transcript can be replayed in tests.
 *
 * Unlike claude's `result` message or codex's `turn.completed`/`turn.failed`,
 * opencode's stream carries no message that marks the run as finished — the
 * process just exits. `finalize()` synthesizes the closing `result` event once
 * the harness sees the stream end, and is what `push()` would emit if opencode
 * had a terminal message of its own.
 */
export class OpencodeTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  ok = false

  /** callID -> whether tool_use has already been emitted for it. */
  private readonly startedTools = new Set<string>()
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalCostUsd = 0
  /** Whether any message was ever seen, so finalize() stays silent on a run that produced no JSON at all. */
  private sawAnyMessage = false

  push(raw: unknown): AgentEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const msg = raw as OpencodeMessage
    this.sawAnyMessage = true

    if (typeof msg.sessionID === 'string') this.sessionId = msg.sessionID

    switch (msg.type) {
      case 'tool_use':
        return msg.part ? this.fromToolUse(msg.part) : []
      case 'text':
        return msg.part?.text ? this.fromText(msg.part.text) : []
      case 'step_finish':
        return msg.part ? this.fromStepFinish(msg.part) : []
      default:
        // step_start carries no progress worth replaying.
        return []
    }
  }

  /** Call once the process's stdout has ended, to emit the closing result. */
  finalize(): AgentEvent[] {
    if (!this.sawAnyMessage) return []
    this.ok = true
    return [
      { kind: 'result', ok: this.ok, ...(this.summary === null ? {} : { summary: this.summary }) },
    ]
  }

  private fromToolUse(part: Part): AgentEvent[] {
    const callID = part.callID
    const name = part.tool ?? 'unknown'
    const status = part.state?.status
    const terminal = status === 'completed' || status === 'error'
    const events: AgentEvent[] = []

    if (callID === undefined || !this.startedTools.has(callID)) {
      if (callID !== undefined) this.startedTools.add(callID)
      events.push({ kind: 'tool_use', name, input: part.state?.input })
    }
    if (terminal) {
      events.push({
        kind: 'tool_result',
        name,
        ok: status === 'completed',
        output: renderToolResult(part.state?.output),
      })
    }
    return events
  }

  private fromText(text: string): AgentEvent[] {
    this.summary = text
    return [{ kind: 'text', text }]
  }

  private fromStepFinish(part: Part): AgentEvent[] {
    const inputTokens = part.tokens?.input ?? 0
    const outputTokens = part.tokens?.output ?? 0
    const costUsd = part.cost ?? 0

    this.totalInputTokens += inputTokens
    this.totalOutputTokens += outputTokens
    this.totalCostUsd += costUsd
    this.usage = {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      costUsd: this.totalCostUsd,
    }
    return [{ kind: 'usage', inputTokens, outputTokens, costUsd }]
  }
}

export type OpencodeHarnessOptions = {
  bin?: string
}

export class OpencodeHarness implements Harness {
  readonly kind = 'opencode'
  private readonly bin: string

  constructor(opts: OpencodeHarnessOptions = {}) {
    this.bin = opts.bin ?? 'opencode'
  }

  start(opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, null), opts)
  }

  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, sessionId), opts)
  }

  argv(opts: AgentStartOptions, sessionId: string | null): string[] {
    // opencode has no `--append-system-prompt` equivalent, so it is folded
    // into the message itself.
    const prompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt
    const argv = [this.bin, 'run', prompt, '--format', 'json', '--dir', opts.cwd]

    if (sessionId !== null) argv.push('--session', sessionId)
    if (opts.model) argv.push('--model', opts.model)
    // `--variant` is opencode's provider-specific reasoning effort knob.
    if (opts.effort) argv.push('--variant', opts.effort)

    // opencode has no workspace-write sandbox flag to pair with claude's
    // --allowedTools or codex's -s workspace-write; --auto is the only lever,
    // and only bypass wants it.
    if (opts.permissions === 'bypass') argv.push('--auto')

    argv.push(...(opts.extraArgs ?? []))
    return argv
  }

  private spawn(argv: string[], opts: AgentStartOptions): AgentProcess {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const queue = new AsyncQueue<AgentEvent>()
    const translator = new OpencodeTranslator()
    const stderr = new Response(proc.stderr).text()

    const done: Promise<AgentOutcome> = (async () => {
      try {
        for await (const raw of jsonLines(proc.stdout)) {
          for (const event of translator.push(raw)) queue.push(event)
        }
        for (const event of translator.finalize()) queue.push(event)
      } catch (err) {
        queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
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
        return null
      },
      effort: opts.effort ?? null,
    }
  }
}
