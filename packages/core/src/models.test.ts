import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARDCODED_EFFORTS,
  HARDCODED_MODELS,
  listModelsCached,
  parseClaudeModelHint,
  parseModelLines,
} from './models.ts'

describe('HARDCODED_MODELS', () => {
  test('claude and codex each expose a curated list', () => {
    expect(HARDCODED_MODELS.claude.length).toBeGreaterThan(0)
    expect(HARDCODED_MODELS.codex.length).toBeGreaterThan(0)
    expect(HARDCODED_MODELS.opencode).toBeUndefined()
  })

  test('claude lists its exact model IDs, not bare aliases', () => {
    expect(HARDCODED_MODELS.claude).toEqual([
      'claude-fable-5-1',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ])
  })

  test('codex lists the current gpt family', () => {
    expect(HARDCODED_MODELS.codex).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])
  })
})

describe('HARDCODED_EFFORTS', () => {
  test('claude uses its effort levels, codex its model_reasoning_effort values', () => {
    expect(HARDCODED_EFFORTS.claude).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(HARDCODED_EFFORTS.codex).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(HARDCODED_EFFORTS.opencode).toBeUndefined()
  })
})

describe('parseModelLines', () => {
  test('parses opencode provider/model lines', () => {
    const out = parseModelLines(
      'opencode/big-pickle\nopencode/ling-3.0-flash-fin-free\nlocal/deepseek-ai/DeepSeek-V4-Flash-0731\n',
    )
    expect(out).toEqual([
      'opencode/big-pickle',
      'opencode/ling-3.0-flash-fin-free',
      'local/deepseek-ai/DeepSeek-V4-Flash-0731',
    ])
  })

  test('ignores table headers, separators and blank lines', () => {
    const out = parseModelLines('MODEL  PROVIDER\n------  --------\nopus  Anthropic\n\n')
    expect(out).toEqual(['opus'])
  })

  test('de-duplicates repeated model names', () => {
    expect(parseModelLines('gpt-5\ngpt-5\n')).toEqual(['gpt-5'])
  })
})

describe('parseClaudeModelHint', () => {
  test('parses the alias list out of the /model reply', () => {
    const out = parseClaudeModelHint(
      'Current model: `Sonnet 5` (effort: high)\n' +
        'Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, ' +
        'sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.',
    )
    expect(out).toEqual([
      'sonnet',
      'opus',
      'haiku',
      'fable',
      'best',
      'sonnet[1m]',
      'opus[1m]',
      'fable[1m]',
      'opusplan',
      'default',
    ])
  })

  test('returns an empty list when the reply has no Available: section', () => {
    expect(parseClaudeModelHint('some unrelated error output')).toEqual([])
  })
})

describe('listModelsCached', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'amagi-models-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const cachePath = (kind: string) => join(dir, `${kind}.json`)
  const writeCache = (kind: string, cachedAt: number, models: string[]) =>
    writeFileSync(cachePath(kind), JSON.stringify({ cachedAt, models }))

  test('a fresh cache short-circuits the listing', async () => {
    writeCache('opencode', Date.now(), ['opencode/big-pickle'])
    let called = false
    const models = await listModelsCached(
      'opencode',
      () => {
        called = true
        return Promise.resolve(['should', 'not', 'run'])
      },
      dir,
    )
    expect(models).toEqual(['opencode/big-pickle'])
    expect(called).toBe(false)
  })

  test('a failed listing falls back to stale cached models', async () => {
    writeCache('opencode', Date.now() - 48 * 60 * 60 * 1000, ['opencode/big-pickle'])
    const models = await listModelsCached(
      'opencode',
      () => Promise.reject(new Error('offline')),
      dir,
    )
    expect(models).toEqual(['opencode/big-pickle'])
  })

  test('a successful listing is written to the cache', async () => {
    const models = await listModelsCached('opencode', () => Promise.resolve(['a', 'b']), dir)
    expect(models).toEqual(['a', 'b'])
    expect(JSON.parse(readFileSync(cachePath('opencode'), 'utf8'))).toMatchObject({
      models: ['a', 'b'],
    })
  })

  test('an empty listing is not cached, so it retries next time', async () => {
    expect(await listModelsCached('claude', () => Promise.resolve([]), dir)).toEqual([])
    expect(existsSync(cachePath('claude'))).toBe(false)
  })

  test('curated kinds skip the disk cache and return the live curated list', async () => {
    writeCache('claude', Date.now(), ['stale-generic'])
    let called = false
    const models = await listModelsCached(
      'claude',
      () => {
        called = true
        return Promise.resolve(['claude-opus-5'])
      },
      dir,
    )
    expect(models).toEqual(['claude-opus-5'])
    expect(called).toBe(true)
  })
})
