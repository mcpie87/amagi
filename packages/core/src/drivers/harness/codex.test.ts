import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../events.ts'
import { jsonLines } from '../../jsonl.ts'
import { CodexHarness, CodexRolloutContext, CodexTranslator } from './codex.ts'

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

  test('without a rollout reader no context is reported, since usage is a thread total', async () => {
    const { events } = await replay()
    expect(events.some((e) => e.kind === 'context')).toBe(false)
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
      '-c',
      'skills.include_instructions=false',
      '-c',
      'features.hooks=false',
      '-s',
      'workspace-write',
      'do the thing',
    ])
  })

  test('resume drops -C and -s, which codex exec resume does not accept', () => {
    const argv = new CodexHarness().argv(base, 'sess-42')
    expect(argv).toEqual([
      'codex',
      'exec',
      '--json',
      'resume',
      'sess-42',
      '-c',
      'skills.include_instructions=false',
      '-c',
      'features.hooks=false',
      'do the thing',
    ])
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

  test('effort is wired through as model_reasoning_effort', () => {
    const argv = new CodexHarness().argv({ ...base, effort: 'high' }, null)
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort=high')
  })

  test('effort and system prompt each get their own -c', () => {
    const argv = new CodexHarness().argv(
      { ...base, systemPrompt: 'be terse', effort: 'xhigh' },
      null,
    )
    expect(argv.filter((a) => a === '-c')).toHaveLength(4)
    expect(argv).toContain('developer_instructions=be terse')
    expect(argv).toContain('model_reasoning_effort=xhigh')
  })

  test('extraArgs land before the trailing prompt', () => {
    const argv = new CodexHarness().argv({ ...base, extraArgs: ['--add-dir', '/other'] }, null)
    expect(argv.slice(-3)).toEqual(['--add-dir', '/other', 'do the thing'])
  })

  test('skills are hidden unless extraArgs re-enables them with a later -c', () => {
    const argv = new CodexHarness().argv(
      { ...base, extraArgs: ['-c', 'skills.include_instructions=true'] },
      null,
    )
    const hide = argv.indexOf('skills.include_instructions=false')
    expect(hide).toBeGreaterThan(-1)
    expect(argv.indexOf('skills.include_instructions=true')).toBeGreaterThan(hide)
  })
})

describe('CodexHarness process', () => {
  test('a run that produces no json still resolves with the exit code', async () => {
    const harness = new CodexHarness({ bin: 'false' })
    const proc = harness.start({
      cwd: process.cwd(),
      prompt: 'x',
      seat: `codex-test-${process.pid}-${Date.now()}`,
    })
    const seen: AgentEvent[] = []
    for await (const e of proc.events()) seen.push(e)
    const outcome = await proc.done
    expect(seen).toEqual([])
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).not.toBe(0)
  })
})

describe('CodexHarness listModels', () => {
  const withCodexHome = async (
    write: (dir: string) => void,
    run: () => Promise<void>,
  ): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), 'amagi-codex-home-'))
    const prior = process.env.CODEX_HOME
    process.env.CODEX_HOME = dir
    try {
      write(dir)
      await run()
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prior
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('reads slugs out of the local models cache, skipping hidden entries', async () => {
    await withCodexHome(
      (dir) =>
        writeFileSync(
          join(dir, 'models_cache.json'),
          JSON.stringify({
            models: [
              { slug: 'gpt-5.6-sol', visibility: 'list' },
              { slug: 'codex-auto-review', visibility: 'hide' },
            ],
          }),
        ),
      async () => {
        expect(await new CodexHarness().listModels()).toEqual(['gpt-5.6-sol'])
      },
    )
  })

  test('returns an empty list when no cache file exists yet', async () => {
    await withCodexHome(
      () => {},
      async () => {
        expect(await new CodexHarness().listModels()).toEqual([])
      },
    )
  })
})

describe('CodexRolloutContext', () => {
  const THREAD = '01a0cfbf-6fa0-7c33-9e3e-6e8132dbe00c'
  const tokenCount = (last: number, total: number): string =>
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: total, cached_input_tokens: total - 1000 },
          last_token_usage: { input_tokens: last, cached_input_tokens: last - 1000 },
          model_context_window: 258_400,
        },
      },
    })}\n`

  test('reports the latest request context, not the thread total, as the rollout grows', () => {
    const home = mkdtempSync(join(tmpdir(), 'amagi-codex-home-'))
    try {
      const day = join(home, 'sessions', '2026', '09', '23')
      mkdirSync(day, { recursive: true })
      const file = join(day, `rollout-2026-09-23T21-30-24-${THREAD}.jsonl`)
      writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`)
      const reader = new CodexRolloutContext(home)
      const translator = new CodexTranslator(reader.read)

      expect(translator.push({ type: 'thread.started', thread_id: THREAD })).toEqual([])
      appendFileSync(file, tokenCount(40_000, 40_000) + tokenCount(87_747, 1_598_369))
      expect(translator.push({ type: 'turn.started' })).toEqual([
        { kind: 'context', tokens: 87_747 },
      ])
      expect(translator.push({ type: 'turn.started' })).toEqual([])
      // A line codex is still writing is held back until it is complete.
      const next = tokenCount(88_000, 1_686_366)
      appendFileSync(file, next.slice(0, 50))
      expect(translator.push({ type: 'turn.started' })).toEqual([])
      appendFileSync(file, next.slice(50))
      expect(translator.push({ type: 'turn.started' })).toEqual([
        { kind: 'context', tokens: 88_000 },
      ])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a thread with no rollout file reports nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'amagi-codex-home-'))
    try {
      expect(new CodexRolloutContext(home).read(THREAD)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
