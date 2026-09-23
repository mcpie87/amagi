import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { HARDCODED_EFFORTS } from '../../models.ts'
import type { AgentProcess, AgentStartOptions, AgentUsage, Harness } from '../types.ts'
import { renderToolResult, spawnAgent } from './spawn.ts'

type FileChange = { path: string; kind: string }

type ThreadItem = {
  id: string
  type: string
  text?: string
  command?: string
  aggregated_output?: string
  status?: string
  changes?: FileChange[]
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown } | null
  error?: { message: string } | null
  query?: string
  results?: unknown[]
  items?: { text: string; completed: boolean }[]
  prompt?: string | null
  receiver_thread_ids?: string[]
  agents_states?: unknown
  message?: string
}

type CodexMessage = {
  type?: string
  thread_id?: string
  item?: ThreadItem
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
  }
  error?: { message: string }
  message?: string
}

type ItemPhase = 'started' | 'updated' | 'completed'

type RolloutLine = {
  type?: string
  payload?: { type?: string; info?: { last_token_usage?: { input_tokens?: number } } | null }
}

/** Input context of a thread's latest model request, or null when unknown. */
export type CodexContextReader = (threadId: string) => number | null

const codexHome = (): string => process.env.CODEX_HOME ?? join(homedir(), '.codex')

/**
 * Tails codex's rollout file ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread
 * id>.jsonl) for the `token_count` events it records after every model
 * request. That file is the only place codex exposes a single request's
 * context: `exec --json` reports usage once per turn, summed over every request
 * of the thread, which overshoots the real window many times over.
 */
export class CodexRolloutContext {
  private path: string | null = null
  private nextLookup = 0
  private offset = 0
  private partial = ''
  private latest: number | null = null

  constructor(private readonly home = codexHome()) {}

  read: CodexContextReader = (threadId) => {
    const path = this.locate(threadId)
    if (path === null) return this.latest
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return this.latest
    }
    try {
      const size = fstatSync(fd).size
      if (size <= this.offset) return this.latest
      const buf = Buffer.alloc(size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = size
      const lines = (this.partial + buf.toString('utf8')).split('\n')
      this.partial = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.includes('"token_count"')) continue
        try {
          const msg = JSON.parse(line) as RolloutLine
          const tokens = msg.payload?.info?.last_token_usage?.input_tokens
          if (msg.payload?.type === 'token_count' && typeof tokens === 'number') {
            this.latest = tokens
          }
        } catch {
          // a torn or foreign line must not drop the reading
        }
      }
    } finally {
      closeSync(fd)
    }
    return this.latest
  }

  private locate(threadId: string): string | null {
    if (this.path !== null || Date.now() < this.nextLookup) return this.path
    this.nextLookup = Date.now() + 5_000
    const sessions = join(this.home, 'sessions')
    if (!existsSync(sessions)) return null
    const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`)
    for (const match of glob.scanSync({ cwd: sessions, absolute: true })) {
      this.path = match
      break
    }
    return this.path
  }
}

/**
 * Turns codex's `exec --json` dialect (the `ThreadEvent`/`ThreadItem` shapes
 * from codex-rs's `exec_events.rs`) into the shared AgentEvent union. Split
 * out from the spawn so the recorded transcript can be replayed in tests.
 */
export class CodexTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  ok = false
  private lastContext: number | null = null

  constructor(private readonly readContext: CodexContextReader | null = null) {}

  push(raw: unknown): AgentEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const msg = raw as CodexMessage

    if (typeof msg.thread_id === 'string') this.sessionId = msg.thread_id

    return [...this.fromContext(), ...this.translate(msg)]
  }

  private fromContext(): AgentEvent[] {
    if (this.readContext === null || this.sessionId === null) return []
    const tokens = this.readContext(this.sessionId)
    if (tokens === null || tokens === this.lastContext) return []
    this.lastContext = tokens
    return [{ kind: 'context', tokens }]
  }

  private translate(msg: CodexMessage): AgentEvent[] {
    switch (msg.type) {
      case 'item.started':
        return msg.item ? this.fromItem(msg.item, 'started') : []
      case 'item.updated':
        return msg.item ? this.fromItem(msg.item, 'updated') : []
      case 'item.completed':
        return msg.item ? this.fromItem(msg.item, 'completed') : []
      case 'turn.completed':
        return this.fromTurnCompleted(msg)
      case 'turn.failed':
        return this.fromTurnFailed(msg)
      case 'error':
        return typeof msg.message === 'string' ? [{ kind: 'error', message: msg.message }] : []
      default:
        // thread.started carries only the session id (handled above) and
        // turn.started carries nothing; neither is progress worth replaying.
        return []
    }
  }

  private fromItem(item: ThreadItem, phase: ItemPhase): AgentEvent[] {
    switch (item.type) {
      case 'agent_message':
        if (phase !== 'completed' || !item.text) return []
        this.summary = item.text
        return [{ kind: 'text', text: item.text }]
      case 'reasoning':
        if (phase !== 'completed' || !item.text) return []
        return [{ kind: 'reasoning', text: item.text }]
      case 'command_execution':
        if (phase === 'started') {
          return [{ kind: 'tool_use', name: 'command_execution', input: { command: item.command } }]
        }
        if (phase === 'completed') {
          return [
            {
              kind: 'tool_result',
              name: 'command_execution',
              ok: item.status === 'completed',
              output: item.aggregated_output ?? '',
            },
          ]
        }
        return []
      case 'file_change':
        if (phase === 'started') {
          return [{ kind: 'tool_use', name: 'file_change', input: { changes: item.changes } }]
        }
        if (phase === 'completed') {
          return [
            {
              kind: 'tool_result',
              name: 'file_change',
              ok: item.status === 'completed',
              output: (item.changes ?? []).map((c) => `${c.kind} ${c.path}`).join('\n'),
            },
          ]
        }
        return []
      case 'mcp_tool_call': {
        const name = `${item.server}:${item.tool}`
        if (phase === 'started') return [{ kind: 'tool_use', name, input: item.arguments }]
        if (phase === 'completed') {
          return [
            {
              kind: 'tool_result',
              name,
              ok: item.status === 'completed',
              output: item.error ? item.error.message : renderToolResult(item.result?.content),
            },
          ]
        }
        return []
      }
      case 'web_search':
        if (phase === 'started') {
          return [{ kind: 'tool_use', name: 'web_search', input: { query: item.query } }]
        }
        if (phase === 'completed') {
          return [
            {
              kind: 'tool_result',
              name: 'web_search',
              ok: true,
              output: JSON.stringify(item.results ?? []),
            },
          ]
        }
        return []
      case 'todo_list': {
        const output = (item.items ?? [])
          .map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`)
          .join('\n')
        if (phase === 'started' || phase === 'updated') {
          return [{ kind: 'tool_use', name: 'todo_list', input: { items: item.items } }]
        }
        return [{ kind: 'tool_result', name: 'todo_list', ok: true, output }]
      }
      case 'collab_tool_call': {
        const name = `collab:${item.tool}`
        if (phase === 'started') {
          return [{ kind: 'tool_use', name, input: { prompt: item.prompt } }]
        }
        if (phase === 'completed') {
          return [
            {
              kind: 'tool_result',
              name,
              ok: item.status === 'completed',
              output: JSON.stringify(item.agents_states ?? {}),
            },
          ]
        }
        return []
      }
      case 'error':
        // Non-fatal error surfaced as an item (config warnings, deprecation
        // notices, model reroutes); distinct from the fatal top-level "error".
        return phase === 'completed' && item.message
          ? [{ kind: 'error', message: item.message }]
          : []
      default:
        return []
    }
  }

  private fromTurnCompleted(msg: CodexMessage): AgentEvent[] {
    this.ok = true
    const events: AgentEvent[] = []

    if (msg.usage) {
      this.usage = {
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        cachedTokens: msg.usage.cached_input_tokens ?? 0,
        // Codex's usage payload carries no dollar figure, unlike claude's.
        costUsd: null,
      }
      events.push({
        kind: 'usage',
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        ...(this.usage.cachedTokens === 0 ? {} : { cachedTokens: this.usage.cachedTokens }),
      })
    }
    events.push({
      kind: 'result',
      ok: true,
      ...(this.summary === null ? {} : { summary: this.summary }),
    })
    return events
  }

  private fromTurnFailed(msg: CodexMessage): AgentEvent[] {
    this.ok = false
    this.summary = msg.error?.message ?? null
    return [
      { kind: 'result', ok: false, ...(this.summary === null ? {} : { summary: this.summary }) },
    ]
  }
}

export type CodexHarnessOptions = {
  bin?: string
}

type CodexModelCacheEntry = { slug?: string; visibility?: string }
type CodexModelCache = { models?: CodexModelCacheEntry[] }

export class CodexHarness implements Harness {
  readonly kind = 'codex'
  private readonly bin: string

  constructor(opts: CodexHarnessOptions = {}) {
    this.bin = opts.bin ?? 'codex'
  }

  start(opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, null), opts)
  }

  async listModels(): Promise<string[]> {
    // codex has no `models` subcommand; it does maintain a local cache of the
    // model catalog it fetches for its own pickers, under $CODEX_HOME (the
    // same directory codex reads config.toml and auth.json from).
    const path = join(codexHome(), 'models_cache.json')
    if (!existsSync(path)) return []
    try {
      const cache = JSON.parse(readFileSync(path, 'utf8')) as CodexModelCache
      return (cache.models ?? [])
        .filter((m): m is { slug: string; visibility?: string } => typeof m.slug === 'string')
        .filter((m) => m.visibility !== 'hide')
        .map((m) => m.slug)
    } catch {
      return []
    }
  }

  async listEfforts(): Promise<string[]> {
    return [...HARDCODED_EFFORTS.codex]
  }

  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, sessionId), opts)
  }

  argv(opts: AgentStartOptions, sessionId: string | null): string[] {
    const argv = [this.bin, 'exec', '--json']

    if (sessionId !== null) {
      argv.push('resume', sessionId)
    } else {
      // `resume` has no `-C`; it reuses the cwd the thread was started with,
      // which `Bun.spawn`'s own `cwd` option below already pins to the same
      // worktree.
      argv.push('-C', opts.cwd)
    }

    if (opts.model) argv.push('--model', opts.model)
    // codex has no `--append-system-prompt`; `developer_instructions` is the
    // config key that injects extra instructions as a separate message.
    if (opts.systemPrompt) argv.push('-c', `developer_instructions=${opts.systemPrompt}`)
    if (opts.effort) argv.push('-c', `model_reasoning_effort=${opts.effort}`)
    // Before extraArgs so a repo can turn skills back on: a later -c wins.
    argv.push('-c', 'skills.include_instructions=false')

    if (opts.permissions === 'bypass') {
      argv.push('--dangerously-bypass-approvals-and-sandbox')
    } else if (sessionId === null) {
      // Also unsupported on `resume`; the resumed thread keeps the sandbox
      // policy it was started with, which is always this for a fresh thread.
      argv.push('-s', 'workspace-write')
    }

    argv.push(...(opts.extraArgs ?? []))
    argv.push(opts.prompt)
    return argv
  }

  private spawn(argv: string[], opts: AgentStartOptions): AgentProcess {
    return spawnAgent(
      argv,
      opts,
      new CodexTranslator(new CodexRolloutContext(opts.env?.CODEX_HOME ?? codexHome()).read),
      {
        // codex reports no resolved model over the stream, so the requested one
        // is all the harness knows.
        model: () => opts.model ?? null,
        effort: opts.effort ?? null,
      },
    )
  }
}
