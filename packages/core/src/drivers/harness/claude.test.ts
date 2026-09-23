import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { ClaudeHarness, ClaudeTranslator, DEFAULT_ALLOWED_TOOLS } from './claude.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'claude-stream.jsonl')

async function replay(): Promise<{ events: AgentEvent[]; translator: ClaudeTranslator }> {
  const translator = new ClaudeTranslator()
  const events: AgentEvent[] = []
  const stream = Bun.file(FIXTURE).stream()
  for await (const raw of jsonLines(stream)) events.push(...translator.push(raw))
  return { events, translator }
}

describe('ClaudeTranslator against a recorded transcript', () => {
  test('normalizes the stream into the shared event union', async () => {
    const { events } = await replay()
    expect(events.map((e) => e.kind)).toEqual([
      'context',
      'tool_use',
      'tool_result',
      'text',
      'usage',
      'result',
    ])
  })

  test('the leading non-JSON warning line does not derail parsing', async () => {
    const { translator } = await replay()
    expect(translator.sessionId).toBe('b1be85f4-3be3-4f96-98da-a3902391aacf')
  })

  test('the resolved model is captured from the init message', async () => {
    const { translator } = await replay()
    expect(translator.model).toBe('claude-opus-5')
  })

  test('tool results are joined back to the tool that produced them', async () => {
    const { events } = await replay()
    const result = events.find((e) => e.kind === 'tool_result')
    expect(result).toEqual({ kind: 'tool_result', name: 'Bash', ok: true, output: 'hi' })
  })

  test('tool input survives intact', async () => {
    const { events } = await replay()
    const use = events.find((e) => e.kind === 'tool_use')
    expect(use).toMatchObject({ name: 'Bash' })
  })

  test('context comes from a single request, deduped across its repeated usage', () => {
    const translator = new ClaudeTranslator()
    const request = {
      input_tokens: 3,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 2_000,
    }
    const push = (text: string) =>
      translator.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text }], usage: request },
      })
    expect(push('a')).toEqual([
      { kind: 'context', tokens: 92_003 },
      { kind: 'text', text: 'a' },
    ])
    expect(push('b')).toEqual([{ kind: 'text', text: 'b' }])
  })

  test('usage and cost are carried through', async () => {
    const { events, translator } = await replay()
    expect(events.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      inputTokens: 4,
      outputTokens: 250,
      costUsd: 0.140235,
    })
    expect(translator.usage?.costUsd).toBe(0.140235)
  })

  test('the final summary is captured', async () => {
    const { translator } = await replay()
    expect(translator.ok).toBe(true)
    expect(translator.summary).toContain('hello.txt')
  })

  test('an error result is reported as not ok', () => {
    const translator = new ClaudeTranslator()
    translator.push({ type: 'result', is_error: true, result: 'hit the turn limit' })
    expect(translator.ok).toBe(false)
    expect(translator.summary).toBe('hit the turn limit')
  })

  test('unknown message types are ignored rather than crashing', () => {
    const translator = new ClaudeTranslator()
    expect(translator.push({ type: 'something_new_in_a_later_version' })).toEqual([])
    expect(translator.push(null)).toEqual([])
    expect(translator.push('not an object')).toEqual([])
  })

  test('structured tool_result content is flattened to text', () => {
    const translator = new ClaudeTranslator()
    translator.push({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    })
    const events = translator.push({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'line one' }] },
        ],
      },
    })
    expect(events[0]).toEqual({ kind: 'tool_result', name: 'Read', ok: true, output: 'line one' })
  })
})

describe('ClaudeHarness argv', () => {
  const base = { cwd: '/wt', prompt: 'do the thing' }

  test('always asks for the streaming json dialect', () => {
    const argv = new ClaudeHarness().argv(base, null)
    expect(argv.slice(0, 4)).toEqual(['claude', '-p', 'do the thing'].concat(['--output-format']))
    expect(argv).toContain('stream-json')
    expect(argv).toContain('--verbose')
  })

  test('defaults to an allowlist rather than skipping permissions', () => {
    const argv = new ClaudeHarness().argv(base, null)
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(DEFAULT_ALLOWED_TOOLS.join(' '))
  })

  test('the tool list is a single argv element so extraArgs cannot be swallowed', () => {
    const argv = new ClaudeHarness().argv({ ...base, extraArgs: ['--add-dir', '/other'] }, null)
    expect(argv[argv.indexOf('--allowedTools') + 2]).toBe('--add-dir')
  })

  test("skills are disabled so the operator's own skills do not leak into workers", () => {
    expect(new ClaudeHarness().argv(base, null)).toContain('--disable-slash-commands')
    expect(new ClaudeHarness().argv(base, 'sess-42')).toContain('--disable-slash-commands')
  })

  test('bypass drops the allowlist entirely', () => {
    const argv = new ClaudeHarness().argv({ ...base, permissions: 'bypass' }, null)
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('--allowedTools')
  })

  test('resume targets the prior session', () => {
    const argv = new ClaudeHarness().argv(base, 'sess-42')
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-42')
  })

  test('model and system prompt are forwarded', () => {
    const argv = new ClaudeHarness().argv(
      { ...base, model: 'claude-opus-5', systemPrompt: 'be terse' },
      null,
    )
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5')
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('be terse')
  })
})

describe('ClaudeHarness process', () => {
  test('a run that produces no json still resolves with the exit code', async () => {
    const harness = new ClaudeHarness({ bin: 'false' })
    const proc = harness.start({ cwd: process.cwd(), prompt: 'x' })
    const seen: AgentEvent[] = []
    for await (const e of proc.events()) seen.push(e)
    const outcome = await proc.done
    expect(seen).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).not.toBe(0)
  })
})

describe('ClaudeHarness listModels', () => {
  // claude has no `model list` subcommand; this stands in for `claude -p
  // "/model"`, whose reply listModels() parses for the available names.
  const fakeClaude = (reply: string): { bin: string; dir: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-claude-bin-'))
    const bin = join(dir, 'claude')
    writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${reply}\nEOF\n`)
    chmodSync(bin, 0o755)
    return { bin, dir }
  }

  test('parses the model names out of the /model reply', async () => {
    const { bin, dir } = fakeClaude(
      'Current model: `Sonnet 5` (effort: high)\n' +
        'Usage: /model <name>. Available: sonnet, opus, haiku, or a full model ID.',
    )
    try {
      expect(await new ClaudeHarness({ bin }).listModels()).toEqual(['sonnet', 'opus', 'haiku'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
