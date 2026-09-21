import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { CodexHarness, CodexTranslator } from './codex.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'codex-stream.jsonl')

async function replay(): Promise<{ events: AgentEvent[]; translator: CodexTranslator }> {
  const translator = new CodexTranslator()
  const events: AgentEvent[] = []
  const stream = Bun.file(FIXTURE).stream()
  for await (const raw of jsonLines(stream)) events.push(...translator.push(raw))
  return { events, translator }
}

describe('CodexTranslator against a recorded transcript', () => {
  test('normalizes the stream into the shared event union', async () => {
    const { events } = await replay()
    expect(events.map((e) => e.kind)).toEqual([
      'text',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'text',
      'usage',
      'result',
    ])
  })

  test('thread.started carries the session id', async () => {
    const { translator } = await replay()
    expect(translator.sessionId).toBe('01a0c048-6c78-7390-afeb-861c4e4b0a42')
  })

  test('a file_change item pairs started and completed into tool_use/tool_result', async () => {
    const { events } = await replay()
    const use = events.find((e) => e.kind === 'tool_use' && e.name === 'file_change')
    const result = events.find((e) => e.kind === 'tool_result' && e.name === 'file_change')
    expect(use).toMatchObject({ kind: 'tool_use', name: 'file_change' })
    expect(result).toEqual({
      kind: 'tool_result',
      name: 'file_change',
      ok: true,
      output: 'add /tmp/codex-record/hello.txt',
    })
  })

  test('a command_execution item carries its own output, unlike claude tool_result', async () => {
    const { events } = await replay()
    const result = events.find((e) => e.kind === 'tool_result' && e.name === 'command_execution')
    expect(result).toEqual({ kind: 'tool_result', name: 'command_execution', ok: true, output: '' })
  })

  test('usage has no cost figure, unlike claude, but carries cached input tokens', async () => {
    const { events, translator } = await replay()
    expect(events.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      inputTokens: 28644,
      outputTokens: 83,
      cachedTokens: 26240,
    })
    expect(translator.usage?.costUsd).toBeNull()
  })

  test('the final agent_message is captured as the summary', async () => {
    const { translator } = await replay()
    expect(translator.ok).toBe(true)
    expect(translator.summary).toContain('hello.txt')
  })

  test('turn.failed is reported as not ok, with the error as the summary', () => {
    const translator = new CodexTranslator()
    const events = translator.push({
      type: 'turn.failed',
      error: { message: 'hit the turn limit' },
    })
    expect(translator.ok).toBe(false)
    expect(translator.summary).toBe('hit the turn limit')
    expect(events).toEqual([{ kind: 'result', ok: false, summary: 'hit the turn limit' }])
  })

  test('a fatal top-level error is forwarded as an error event', () => {
    const translator = new CodexTranslator()
    expect(translator.push({ type: 'error', message: 'stream disconnected' })).toEqual([
      { kind: 'error', message: 'stream disconnected' },
    ])
  })

  test('a non-fatal error item (config warnings, deprecations) becomes an error event', () => {
    const translator = new CodexTranslator()
    const events = translator.push({
      type: 'item.completed',
      item: { id: 'item_0', type: 'error', message: 'invalid global instructions' },
    })
    expect(events).toEqual([{ kind: 'error', message: 'invalid global instructions' }])
  })

  test('reasoning items are surfaced only once completed', () => {
    const translator = new CodexTranslator()
    expect(
      translator.push({
        type: 'item.completed',
        item: { id: 'item_0', type: 'reasoning', text: 'weighing the options' },
      }),
    ).toEqual([{ kind: 'reasoning', text: 'weighing the options' }])
  })

  test('unknown message and item types are ignored rather than crashing', () => {
    const translator = new CodexTranslator()
    expect(translator.push({ type: 'something_new_in_a_later_version' })).toEqual([])
    expect(
      translator.push({ type: 'item.completed', item: { id: 'i', type: 'a_new_kind' } }),
    ).toEqual([])
    expect(translator.push(null)).toEqual([])
    expect(translator.push('not an object')).toEqual([])
  })
})

describe('CodexHarness argv', () => {
  const base = { cwd: '/wt', prompt: 'do the thing' }

  test('a fresh start uses exec --json with -C for the worktree', () => {
    const argv = new CodexHarness().argv(base, null)
    expect(argv).toEqual([
      'codex',
      'exec',
      '--json',
      '-C',
      '/wt',
      '-s',
      'workspace-write',
      'do the thing',
    ])
  })

  test('resume drops -C and -s, which codex exec resume does not accept', () => {
    const argv = new CodexHarness().argv(base, 'sess-42')
    expect(argv).toEqual(['codex', 'exec', '--json', 'resume', 'sess-42', 'do the thing'])
  })

  test('bypass swaps the sandbox flag on a fresh start', () => {
    const argv = new CodexHarness().argv({ ...base, permissions: 'bypass' }, null)
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv).not.toContain('-s')
  })

  test('bypass is still honored on resume, unlike the sandbox flag', () => {
    const argv = new CodexHarness().argv({ ...base, permissions: 'bypass' }, 'sess-42')
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  test('model and system prompt are forwarded, the latter via developer_instructions', () => {
    const argv = new CodexHarness().argv(
      { ...base, model: 'gpt-5.1-codex', systemPrompt: 'be terse' },
      null,
    )
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.1-codex')
    expect(argv[argv.indexOf('-c') + 1]).toBe('developer_instructions=be terse')
  })

  test('extraArgs land before the trailing prompt', () => {
    const argv = new CodexHarness().argv({ ...base, extraArgs: ['--add-dir', '/other'] }, null)
    expect(argv.slice(-3)).toEqual(['--add-dir', '/other', 'do the thing'])
  })
})

describe('CodexHarness process', () => {
  test('a run that produces no json still resolves with the exit code', async () => {
    const harness = new CodexHarness({ bin: 'false' })
    const proc = harness.start({ cwd: process.cwd(), prompt: 'x' })
    const seen: AgentEvent[] = []
    for await (const e of proc.events()) seen.push(e)
    const outcome = await proc.done
    expect(seen).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).not.toBe(0)
  })
})
