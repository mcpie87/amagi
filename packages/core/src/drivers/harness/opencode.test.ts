import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { OpencodeHarness, OpencodeTranslator } from './opencode.ts'

const FIXTURE = join(import.meta.dir, 'fixtures', 'opencode-stream.jsonl')

async function replay(): Promise<{ events: AgentEvent[]; translator: OpencodeTranslator }> {
  const translator = new OpencodeTranslator()
  const events: AgentEvent[] = []
  const stream = Bun.file(FIXTURE).stream()
  for await (const raw of jsonLines(stream)) events.push(...translator.push(raw))
  events.push(...translator.finalize())
  return { events, translator }
}

describe('OpencodeTranslator against a recorded transcript', () => {
  test('normalizes the stream into the shared event union', async () => {
    const { events } = await replay()
    expect(events.map((e) => e.kind)).toEqual([
      'tool_use',
      'tool_result',
      'usage',
      'tool_use',
      'tool_result',
      'usage',
      'tool_use',
      'tool_result',
      'usage',
      'text',
      'usage',
      'result',
    ])
  })

  test('the session id is read off every message', async () => {
    const { translator } = await replay()
    expect(translator.sessionId).toBe('ses_f3f8a1909ffektVhOtgdIkDGpo')
  })

  test('a completed tool_use pairs into tool_use/tool_result with its own output', async () => {
    const { events } = await replay()
    const use = events.find((e) => e.kind === 'tool_use' && e.name === 'write')
    const result = events.find((e) => e.kind === 'tool_result' && e.name === 'write')
    expect(use).toMatchObject({ kind: 'tool_use', name: 'write' })
    expect(result).toEqual({
      kind: 'tool_result',
      name: 'write',
      ok: true,
      output: 'Wrote file successfully.',
    })
  })

  test('a bash tool_use carries its own command output, unlike claude tool_result', async () => {
    const { events } = await replay()
    const results = events.filter((e) => e.kind === 'tool_result' && e.name === 'bash')
    expect(results).toEqual([
      { kind: 'tool_result', name: 'bash', ok: true, output: '(no output)' },
      {
        kind: 'tool_result',
        name: 'bash',
        ok: true,
        output: '2 hello.txt\n0000000   h   i\n0000002\n',
      },
    ])
  })

  test('usage is emitted per step_finish, but the translator accumulates the running total', async () => {
    const { events, translator } = await replay()
    const usageEvents = events.filter((e) => e.kind === 'usage')
    expect(usageEvents).toEqual([
      { kind: 'usage', inputTokens: 12067, outputTokens: 68, cachedTokens: 1792, costUsd: 0 },
      { kind: 'usage', inputTokens: 118, outputTokens: 67, cachedTokens: 13824, costUsd: 0 },
      { kind: 'usage', inputTokens: 198, outputTokens: 54, cachedTokens: 13824, costUsd: 0 },
      { kind: 'usage', inputTokens: 279, outputTokens: 29, cachedTokens: 13824, costUsd: 0 },
    ])
    expect(translator.usage).toEqual({
      inputTokens: 12662,
      outputTokens: 218,
      cachedTokens: 43264,
      costUsd: 0,
    })
  })

  test('the final text is captured as the summary', async () => {
    const { translator } = await replay()
    expect(translator.summary).toContain('hello.txt')
  })

  test('finalize synthesizes the closing result, which opencode never sends itself', async () => {
    const { translator } = await replay()
    expect(translator.ok).toBe(true)
  })

  test('finalize stays silent when the stream never carried a single message', () => {
    const translator = new OpencodeTranslator()
    expect(translator.finalize()).toEqual([])
    expect(translator.ok).toBe(false)
  })

  test('unknown message types are ignored rather than crashing', () => {
    const translator = new OpencodeTranslator()
    expect(translator.push({ type: 'something_new_in_a_later_version' })).toEqual([])
    expect(translator.push(null)).toEqual([])
    expect(translator.push('not an object')).toEqual([])
  })

  test('a tool_use split across a running update and a completed update is paired once', () => {
    const translator = new OpencodeTranslator()
    const started = translator.push({
      type: 'tool_use',
      sessionID: 's1',
      part: { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running' } },
    })
    expect(started).toEqual([{ kind: 'tool_use', name: 'bash', input: undefined }])

    const finished = translator.push({
      type: 'tool_use',
      sessionID: 's1',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_1',
        state: { status: 'completed', output: 'done' },
      },
    })
    expect(finished).toEqual([{ kind: 'tool_result', name: 'bash', ok: true, output: 'done' }])
  })

  test('a failed tool_use is reported as not ok', () => {
    const translator = new OpencodeTranslator()
    const events = translator.push({
      type: 'tool_use',
      sessionID: 's1',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'call_1',
        state: { status: 'error', output: 'command not found' },
      },
    })
    expect(events).toEqual([
      { kind: 'tool_use', name: 'bash', input: undefined },
      { kind: 'tool_result', name: 'bash', ok: false, output: 'command not found' },
    ])
  })

  test('structured tool output is rendered as JSON rather than crashing', () => {
    const translator = new OpencodeTranslator()
    const events = translator.push({
      type: 'tool_use',
      sessionID: 's1',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'call_1',
        state: { status: 'completed', output: { lines: 3 } },
      },
    })
    expect(events[1]).toEqual({
      kind: 'tool_result',
      name: 'read',
      ok: true,
      output: '{"lines":3}',
    })
  })
})

describe('OpencodeHarness argv', () => {
  const base = { cwd: '/wt', prompt: 'do the thing' }

  test('a fresh start asks for the json format in the target directory', () => {
    const argv = new OpencodeHarness().argv(base, null)
    expect(argv).toEqual(['opencode', 'run', '--format', 'json', '--dir', '/wt'])
  })

  test('resume continues the prior session by id', () => {
    const argv = new OpencodeHarness().argv(base, 'sess-42')
    expect(argv).toContain('--session')
    expect(argv[argv.indexOf('--session') + 1]).toBe('sess-42')
  })

  test('model and effort are forwarded as --model and --variant', () => {
    const argv = new OpencodeHarness().argv(
      { ...base, model: 'opencode/big-pickle', effort: 'high' },
      null,
    )
    expect(argv[argv.indexOf('--model') + 1]).toBe('opencode/big-pickle')
    expect(argv[argv.indexOf('--variant') + 1]).toBe('high')
  })

  test('bypass adds --auto, which is otherwise absent', () => {
    const defaultArgv = new OpencodeHarness().argv(base, null)
    expect(defaultArgv).not.toContain('--auto')

    const bypassArgv = new OpencodeHarness().argv({ ...base, permissions: 'bypass' }, null)
    expect(bypassArgv).toContain('--auto')
  })

  test('extraArgs are appended at the end', () => {
    const argv = new OpencodeHarness().argv({ ...base, extraArgs: ['--pure'] }, null)
    expect(argv.at(-1)).toBe('--pure')
  })
})

describe('OpencodeHarness process', () => {
  test('a run that produces no json still resolves with the exit code', async () => {
    const harness = new OpencodeHarness({ bin: 'false' })
    const proc = harness.start({ cwd: process.cwd(), prompt: 'x' })
    const seen: AgentEvent[] = []
    for await (const e of proc.events()) seen.push(e)
    const outcome = await proc.done
    expect(seen).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).not.toBe(0)
  })

  test('the folded prompt is piped through stdin, not argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-stdin-'))
    try {
      const bin = join(dir, 'echo-stdin')
      writeFileSync(bin, '#!/bin/sh\ncat >&2\n')
      chmodSync(bin, 0o755)
      const harness = new OpencodeHarness({ bin })
      const proc = harness.start({ cwd: dir, prompt: 'do the thing', systemPrompt: 'be terse' })
      const seen: AgentEvent[] = []
      for await (const e of proc.events()) seen.push(e)
      const outcome = await proc.done
      expect(seen).toEqual([])
      expect(outcome.stderr).toBe('be terse\n\ndo the thing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the skill tool is denied through OPENCODE_CONFIG_CONTENT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-env-'))
    try {
      const bin = join(dir, 'echo-env')
      writeFileSync(bin, '#!/bin/sh\nprintf %s "$OPENCODE_CONFIG_CONTENT" >&2\n')
      chmodSync(bin, 0o755)
      const outcome = await new OpencodeHarness({ bin }).start({ cwd: dir, prompt: 'x' }).done
      expect(JSON.parse(outcome.stderr)).toEqual({ permission: { skill: 'deny' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('opts.env still overrides the skill deny', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-env-'))
    try {
      const bin = join(dir, 'echo-env')
      writeFileSync(bin, '#!/bin/sh\nprintf %s "$OPENCODE_CONFIG_CONTENT" >&2\n')
      chmodSync(bin, 0o755)
      const outcome = await new OpencodeHarness({ bin }).start({
        cwd: dir,
        prompt: 'x',
        env: { OPENCODE_CONFIG_CONTENT: '{}' },
      }).done
      expect(outcome.stderr).toBe('{}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
