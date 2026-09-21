import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { CommandError, exec } from '../../exec.ts'
import { cacheHome } from '../../paths.ts'
import type { AgentProcess, AgentStartOptions, AgentUsage, Harness } from '../types.ts'
import { spawnAgent } from './spawn.ts'

type CodexModel = { slug: string; efforts: string[] }

/**
 * Parses `codex debug models` (the raw model catalog as JSON). Only
 * `list`-visibility entries are offered to the picker; each carries the
 * reasoning levels that model actually supports.
 */
export function parseCodexCatalog(stdout: string): CodexModel[] {
  try {
    const raw = JSON.parse(stdout) as { models?: unknown }
    if (!Array.isArray(raw.models)) return []
    const out: CodexModel[] = []
    for (const m of raw.models) {
      if (typeof m !== 'object' || m === null) continue
      const rec = m as Record<string, unknown>
      if (rec.visibility !== 'list' || typeof rec.slug !== 'string') continue
      const efforts = Array.isArray(rec.supported_reasoning_levels)
        ? [
            ...new Set(
              rec.supported_reasoning_levels.flatMap((l) => {
                if (typeof l !== 'object' || l === null) return []
                const effort = (l as { effort?: unknown }).effort
                return typeof effort === 'string' ? [effort] : []
              }),
            ),
          ]
        : []
      out.push({ slug: rec.slug, efforts })
    }
    return out
  } catch {
    return []
  }
}

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000

type CatalogEntry = { cachedAt: number; models: CodexModel[] }

/**
 * Runs `codex debug models` once per day and caches the parsed catalog, so
 * the model and effort pickers stay fast and work offline: a fresh cache
 * wins and a failed listing falls back to whatever is cached.
 */
async function listCatalog(bin: string): Promise<CodexModel[]> {
  const file = join(cacheHome(), 'amagi', 'models', 'codex-catalog.json')
  const read = (): CatalogEntry | null => {
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as CatalogEntry
    } catch {
      return null
    }
  }
  const cached = read()
  if (cached !== null && Date.now() - cached.cachedAt < CATALOG_TTL_MS) return cached.models

  const cmd = [bin, 'debug', 'models']
  try {
    const result = await exec(cmd)
    if (result.exitCode !== 0) throw new CommandError(cmd, result)
    const models = parseCodexCatalog(result.stdout)
    if (models.length > 0) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cachedAt: Date.now(), models }))
    }
    return models
  } catch {
    return cached?.models ?? []
  }
}

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
  }
  error?: { message: string }
  message?: string
}

type ItemPhase = 'started' | 'updated' | 'completed'

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
 * Turns codex's `exec --json` dialect (the `ThreadEvent`/`ThreadItem` shapes
 * from codex-rs's `exec_events.rs`) into the shared AgentEvent union. Split
 * out from the spawn so the recorded transcript can be replayed in tests.
 */
export class CodexTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  ok = false

  push(raw: unknown): AgentEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const msg = raw as CodexMessage

    if (typeof msg.thread_id === 'string') this.sessionId = msg.thread_id

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
        // Codex's usage payload carries no dollar figure, unlike claude's.
        costUsd: null,
      }
      events.push({
        kind: 'usage',
        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
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
    return (await listCatalog(this.bin)).map((m) => m.slug)
  }

  /** The reasoning levels the picked model supports, or the union across the catalog. */
  async listEfforts(model?: string): Promise<string[]> {
    const catalog = await listCatalog(this.bin)
    const entry = model === undefined ? undefined : catalog.find((m) => m.slug === model)
    return entry?.efforts ?? [...new Set(catalog.flatMap((m) => m.efforts))]
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
    // `model_reasoning_effort` is the config key codex reads for reasoning effort.
    if (opts.effort) argv.push('-c', `model_reasoning_effort=${opts.effort}`)

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
    return spawnAgent(argv, opts, new CodexTranslator(), {
      // codex reports no resolved model over the stream, so the requested one
      // is all the harness knows.
      model: () => opts.model ?? null,
      effort: opts.effort ?? null,
    })
  }
}
