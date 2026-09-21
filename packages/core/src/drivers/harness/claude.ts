import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { CommandError, exec } from '../../exec.ts'
import { parseModelLines } from '../../models.ts'
import type { AgentProcess, AgentStartOptions, AgentUsage, Harness } from '../types.ts'
import { spawnAgent } from './spawn.ts'

/**
 * Enough to implement a task and call `amagi ask`, without handing over the
 * whole permission system. Overridden per repo via harness.allowedTools.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
] as const

type ContentBlock = {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

type ClaudeMessage = {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  model?: string
  message?: { model?: string; content?: ContentBlock[] }
  usage?: { input_tokens?: number; output_tokens?: number }
}

function renderToolResult(content: unknown): string {
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
 * Turns claude's stream-json dialect into the shared AgentEvent union. Split
 * out from the spawn so the recorded transcript can be replayed in tests.
 */
export class ClaudeTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  ok = false
  /** The model claude reports it resolved to; the init line carries it. */
  model: string | null = null

  /** tool_result carries only the tool_use_id, so names are remembered here. */
  private readonly toolNames = new Map<string, string>()

  push(raw: unknown): AgentEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const msg = raw as ClaudeMessage

    if (typeof msg.session_id === 'string') this.sessionId = msg.session_id
    const model = msg.model ?? msg.message?.model
    if (typeof model === 'string') this.model = model

    switch (msg.type) {
      case 'assistant':
        return (msg.message?.content ?? []).flatMap((b) => this.fromAssistant(b))
      case 'user':
        return (msg.message?.content ?? []).flatMap((b) => this.fromUser(b))
      case 'result':
        return this.fromResult(msg)
      default:
        // system/init and rate_limit_event carry no progress worth replaying.
        return []
    }
  }

  private fromAssistant(block: ContentBlock): AgentEvent[] {
    if (block.type === 'text' && block.text) return [{ kind: 'text', text: block.text }]
    if (block.type === 'thinking' && block.thinking) {
      return [{ kind: 'reasoning', text: block.thinking }]
    }
    if (block.type === 'tool_use' && block.name) {
      if (block.id) this.toolNames.set(block.id, block.name)
      return [{ kind: 'tool_use', name: block.name, input: block.input }]
    }
    return []
  }

  private fromUser(block: ContentBlock): AgentEvent[] {
    if (block.type !== 'tool_result') return []
    const name =
      (block.tool_use_id ? this.toolNames.get(block.tool_use_id) : undefined) ?? 'unknown'
    return [
      {
        kind: 'tool_result',
        name,
        ok: block.is_error !== true,
        output: renderToolResult(block.content),
      },
    ]
  }

  private fromResult(msg: ClaudeMessage): AgentEvent[] {
    this.ok = msg.is_error !== true
    this.summary = msg.result ?? null

    const events: AgentEvent[] = []
    if (msg.usage) {
      this.usage = {
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        costUsd: msg.total_cost_usd ?? null,
      }
      events.push({
        kind: 'usage',
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        ...(this.usage.costUsd === null ? {} : { costUsd: this.usage.costUsd }),
      })
    }
    events.push({
      kind: 'result',
      ok: this.ok,
      ...(this.summary === null ? {} : { summary: this.summary }),
    })
    return events
  }
}

export type ClaudeHarnessOptions = {
  bin?: string
}

export class ClaudeHarness implements Harness {
  readonly kind = 'claude'
  private readonly bin: string
  private readonly defaultEffort: string | null

  constructor(opts: ClaudeHarnessOptions = {}) {
    this.bin = opts.bin ?? 'claude'
    // claude does not report effort over the stream, so the harness reads the
    // same settings file claude reads to know what effort is in effect.
    this.defaultEffort = ClaudeHarness.effortFromSettings()
  }

  private static effortFromSettings(): string | null {
    try {
      const path = join(process.env.HOME ?? '', '.claude', 'settings.json')
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { effortLevel?: unknown }
      return typeof raw.effortLevel === 'string' ? raw.effortLevel : null
    } catch {
      return null
    }
  }

  start(opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, null), opts)
  }

  async listModels(): Promise<string[]> {
    const cmd = [this.bin, 'model', 'list']
    const result = await exec(cmd)
    if (result.exitCode !== 0) throw new CommandError(cmd, result)
    return parseModelLines(result.stdout)
  }

  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, sessionId), opts)
  }

  argv(opts: AgentStartOptions, sessionId: string | null): string[] {
    const argv = [this.bin, '-p', opts.prompt, '--output-format', 'stream-json', '--verbose']

    if (sessionId !== null) argv.push('--resume', sessionId)
    if (opts.model) argv.push('--model', opts.model)
    if (opts.systemPrompt) argv.push('--append-system-prompt', opts.systemPrompt)

    if (opts.permissions === 'bypass') {
      argv.push('--dangerously-skip-permissions')
    } else {
      // One argv element: --allowedTools is variadic and would otherwise
      // swallow whatever extraArgs adds next.
      argv.push('--allowedTools', (opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(' '))
    }

    argv.push(...(opts.extraArgs ?? []))
    return argv
  }

  private spawn(argv: string[], opts: AgentStartOptions): AgentProcess {
    const translator = new ClaudeTranslator()
    return spawnAgent(argv, opts, translator, {
      // claude reads its effort from the CLAUDE_EFFORT env var, not a flag.
      env: opts.effort ? { CLAUDE_EFFORT: opts.effort } : {},
      model: () => translator.model,
      effort: opts.effort ?? this.defaultEffort,
    })
  }
}
