import type { AgentEvent } from '../../events.ts'
import { CommandError, exec } from '../../exec.ts'
import type { AgentProcess, AgentStartOptions, AgentUsage, Harness } from '../types.ts'
import { renderToolResult, spawnAgent } from './spawn.ts'

type OmpMessage = {
  type?: string
  id?: string
  toolName?: string
  toolCallId?: string
  args?: unknown
  result?: unknown
  isError?: boolean
  messages?: unknown[]
  message?: unknown
  assistantMessageEvent?: { type?: string; delta?: string }
}

type OmpRecord = Record<string, unknown>

const asRecord = (value: unknown): OmpRecord | null =>
  typeof value === 'object' && value !== null ? (value as OmpRecord) : null

/** Translates documented `omp --mode json` AgentSessionEvent records. */
export class OmpTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  ok = false

  push(raw: unknown): AgentEvent[] {
    const msg = asRecord(raw) as OmpMessage | null
    if (msg === null) return []
    if (msg.type === 'header' && typeof msg.id === 'string') this.sessionId = msg.id

    switch (msg.type) {
      case 'message_update': {
        const event = msg.assistantMessageEvent
        if (event?.type === 'text_delta' && typeof event.delta === 'string') {
          this.summary = (this.summary ?? '') + event.delta
          return [{ kind: 'text', text: event.delta }]
        }
        if (event?.type === 'thinking_delta' && typeof event.delta === 'string') {
          return [{ kind: 'reasoning', text: event.delta }]
        }
        return []
      }
      case 'tool_execution_start':
        return [
          {
            kind: 'tool_use',
            name: msg.toolName ?? 'tool',
            input: msg.args ?? {},
          },
        ]
      case 'tool_execution_end':
        return [
          {
            kind: 'tool_result',
            name: msg.toolName ?? 'tool',
            ok: msg.isError !== true,
            output: renderToolResult(msg.result),
          },
        ]
      case 'agent_end': {
        const messages = msg.messages ?? []
        const last = asRecord(messages.at(-1))
        const failed = last?.stopReason === 'error'
        this.ok = !failed
        if (typeof last?.errorMessage === 'string') this.summary = last.errorMessage
        return [
          {
            kind: 'result',
            ok: this.ok,
            ...(this.summary === null ? {} : { summary: this.summary }),
          },
        ]
      }
      default:
        return []
    }
  }

  finalize(): AgentEvent[] {
    return [
      { kind: 'result', ok: this.ok, ...(this.summary === null ? {} : { summary: this.summary }) },
    ]
  }
}
export function parseOmpModels(stdout: string): string[] {
  const parsed = JSON.parse(stdout) as { models?: { selector?: unknown }[] }
  return (parsed.models ?? []).flatMap((model) =>
    typeof model.selector === 'string' ? [model.selector] : [],
  )
}

export type OmpHarnessOptions = { bin?: string | string[] | undefined; seat?: string }

export class OmpHarness implements Harness {
  readonly kind = 'omp'
  readonly replacesSystemPromptOnResume = false
  private readonly bin: string[]
  private readonly seat: string | undefined

  constructor(opts: OmpHarnessOptions = {}) {
    this.bin = [opts.bin ?? 'omp'].flat()
    this.seat = opts.seat
  }

  start(opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, null), opts)
  }
  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, sessionId), opts)
  }

  async listModels(): Promise<string[]> {
    const cmd = [...this.bin, 'models', '--json']
    const result = await exec(cmd)
    if (result.exitCode !== 0) throw new CommandError(cmd, result)
    return parseOmpModels(result.stdout)
  }

  async listEfforts(): Promise<string[]> {
    return []
  }

  argv(opts: AgentStartOptions, sessionId: string | null): string[] {
    const argv = [...this.bin, '-p', '--mode', 'json', '--cwd', opts.cwd]
    if (sessionId !== null) argv.push('-r', sessionId)
    if (opts.model) argv.push('--model', opts.model)
    if (opts.effort) argv.push('--thinking', opts.effort)
    if (opts.systemPrompt) argv.push('--append-system-prompt', opts.systemPrompt)
    if (opts.permissions === 'read-only') argv.push('--approval-mode', 'always-ask')
    else if (opts.permissions === 'workspace-write') argv.push('--approval-mode', 'write')
    else if (opts.permissions === 'bypass') argv.push('--approval-mode', 'yolo')
    argv.push(...(opts.extraArgs ?? []))
    return argv
  }

  private spawn(argv: string[], opts: AgentStartOptions): AgentProcess {
    const seat = opts.seat === null ? null : (opts.seat ?? this.seat ?? this.kind)
    opts = { ...opts, seat }
    const translator = new OmpTranslator()
    return spawnAgent(argv, opts, translator, {
      seat,
      finalize: () => translator.finalize(),
      model: () => opts.model ?? null,
      effort: opts.effort ?? null,
      stdin: opts.prompt,
    })
  }
}
