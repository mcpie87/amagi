import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderOptions, recordPick } from './pick-history.ts'

let dir: string

const tmpPath = (name: string) => {
  dir = mkdtempSync(join(tmpdir(), 'amagi-pick-history-'))
  return join(dir, name)
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('orderOptions', () => {
  test('floats the most-picked option to the top and keeps ties fixed', () => {
    const path = tmpPath('history.json')
    recordPick('Which harness?', 'b', path)
    recordPick('Which harness?', 'b', path)
    recordPick('Which harness?', 'c', path)
    const labels = orderOptions(
      'Which harness?',
      [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
      path,
    ).map((o) => o.label)
    expect(labels).toEqual(['b', 'c', 'a'])
  })

  test('history is keyed by picker title, not shared across pickers', () => {
    const path = tmpPath('history.json')
    recordPick('Which harness?', 'fast', path)
    const labels = orderOptions('Which model?', [{ label: 'fast' }, { label: 'slow' }], path).map(
      (o) => o.label,
    )
    expect(labels).toEqual(['fast', 'slow'])
  })

  test('missing history keeps the fixed order', () => {
    const labels = orderOptions('t', [{ label: 'x' }, { label: 'y' }], tmpPath('none.json')).map(
      (o) => o.label,
    )
    expect(labels).toEqual(['x', 'y'])
  })

  test('corrupt history is ignored', () => {
    const path = tmpPath('corrupt.json')
    writeFileSync(path, '{not json')
    const labels = orderOptions('t', [{ label: 'x' }, { label: 'y' }], path).map((o) => o.label)
    expect(labels).toEqual(['x', 'y'])
  })
})
