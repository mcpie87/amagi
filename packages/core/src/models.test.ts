import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listModelsCached, parseModelLines } from './models.ts'

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
})
