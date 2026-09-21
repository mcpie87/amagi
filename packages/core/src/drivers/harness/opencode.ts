import type { AgentEvent } from '../../events.ts'
import { CommandError, exec } from '../../exec.ts'
import { parseModelLines } from '../../models.ts'
import type { AgentProcess, AgentStartOptions, AgentUsage, Harness } from '../types.ts'
import { renderToolResult, spawnAgent } from './spawn.ts'

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
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }
  cost?: number
}

type OpencodeMessage = {
  type?: string
  sessionID?: string
  part?: Part
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
  private totalCachedTokens = 0
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
    const cachedTokens = part.tokens?.cache?.read ?? 0
    const costUsd = part.cost ?? 0

    this.totalInputTokens += inputTokens
    this.totalOutputTokens += outputTokens
    this.totalCachedTokens += cachedTokens
    this.totalCostUsd += costUsd
    this.usage = {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      cachedTokens: this.totalCachedTokens,
      costUsd: this.totalCostUsd,
    }
    return [
      {
        kind: 'usage',
        inputTokens,
        outputTokens,
        ...(cachedTokens === 0 ? {} : { cachedTokens }),
        costUsd,
      },
    ]
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

  async listModels(): Promise<string[]> {
    const cmd = [this.bin, 'models']
    const result = await exec(cmd)
    if (result.exitCode !== 0) throw new CommandError(cmd, result)
    return parseModelLines(result.stdout)
  }

  // opencode's `--variant` is provider-specific, so there is no universal list.
  async listEfforts(): Promise<string[]> {
    return []
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
    const translator = new OpencodeTranslator()
    return spawnAgent(argv, opts, translator, {
      finalize: () => translator.finalize(),
      effort: opts.effort ?? null,
    })
  }
}
