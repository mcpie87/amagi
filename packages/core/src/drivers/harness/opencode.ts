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
import { harnessEnv } from './env.ts'

type OpenCodePart = {
  type?: string
  text?: string
  tool?: string
  state?: {
    status?: string
    input?: unknown
    output?: string
    error?: string
  }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  cost?: number
}

type OpenCodeMessage = {
  type?: string
  sessionID?: string
  part?: OpenCodePart
  error?: { name?: string; data?: { message?: string } }
}

export class OpenCodeTranslator {
  sessionId: string | null = null
  summary: string | null = null
  usage: AgentUsage | null = null
  hasError = false

  push(raw: unknown): AgentEvent[] {
    if (typeof raw !== 'object' || raw === null) return []
    const msg = raw as OpenCodeMessage
    if (typeof msg.sessionID === 'string') this.sessionId = msg.sessionID

    if (msg.type === 'error') {
      this.hasError = true
      const message = msg.error?.data?.message ?? msg.error?.name ?? 'OpenCode failed'
      return [{ kind: 'error', message }]
    }

    const part = msg.part
    if (part === undefined) return []
    if (part.type === 'text' && part.text) {
      this.summary = part.text
      return [{ kind: 'text', text: part.text }]
    }
    if (part.type === 'reasoning' && part.text) return [{ kind: 'reasoning', text: part.text }]
    if (part.type === 'tool' && part.tool) {
      const ok = part.state?.status === 'completed'
      if (part.state?.status !== 'completed' && part.state?.status !== 'error') return []
      return [
        { kind: 'tool_use', name: part.tool, input: part.state?.input },
        {
          kind: 'tool_result',
          name: part.tool,
          ok,
          output: part.state?.output ?? part.state?.error ?? '',
        },
      ]
    }
    if (part.type === 'step-finish') {
      const tokens = part.tokens
      if (tokens === undefined) return []
      this.usage = {
        inputTokens: tokens.input ?? 0,
        outputTokens: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
        costUsd: part.cost ?? null,
      }
      return [
        {
          kind: 'usage',
          inputTokens: this.usage.inputTokens,
          outputTokens: this.usage.outputTokens,
          ...(this.usage.costUsd === null ? {} : { costUsd: this.usage.costUsd }),
        },
      ]
    }
    return []
  }
}

export type OpenCodeHarnessOptions = {
  bin?: string
}

export class OpenCodeHarness implements Harness {
  readonly kind = 'opencode'
  private readonly bin: string

  constructor(opts: OpenCodeHarnessOptions = {}) {
    this.bin = opts.bin ?? 'opencode'
  }

  start(opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, null), opts)
  }

  resume(sessionId: string, opts: AgentStartOptions): AgentProcess {
    return this.spawn(this.argv(opts, sessionId), opts)
  }

  argv(opts: AgentStartOptions, sessionId: string | null): string[] {
    const prompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt
    const argv = [this.bin, 'run', '--format', 'json']

    if (sessionId !== null) argv.push('--session', sessionId)
    if (opts.model) argv.push('--model', opts.model)
    if (opts.effort) argv.push('--variant', opts.effort)
    if (opts.permissions === 'bypass') argv.push('--auto')

    argv.push(...(opts.extraArgs ?? []), prompt)
    return argv
  }

  private spawn(argv: string[], opts: AgentStartOptions): AgentProcess {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: { ...harnessEnv(), ...opts.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const queue = new AsyncQueue<AgentEvent>()
    const translator = new OpenCodeTranslator()
    const stderr = new Response(proc.stderr).text()
    const done: Promise<AgentOutcome> = (async () => {
      try {
        for await (const raw of jsonLines(proc.stdout)) {
          for (const event of translator.push(raw)) queue.push(event)
        }
      } catch (err) {
        queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        const exitCode = await proc.exited
        queue.push({
          kind: 'result',
          ok: !translator.hasError && exitCode === 0,
          ...(translator.summary === null ? {} : { summary: translator.summary }),
        })
        queue.close()
      }

      const exitCode = await proc.exited
      return {
        exitCode,
        ok: !translator.hasError && exitCode === 0,
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
        return opts.model ?? null
      },
      effort: opts.effort ?? null,
    }
  }
}
