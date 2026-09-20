import { describe, expect, test } from 'bun:test'
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
