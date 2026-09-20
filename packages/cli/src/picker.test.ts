import { describe, expect, test } from 'bun:test'
import { input, type Key, select } from './picker.ts'

const keys = (ks: Key[]) => {
  let i = 0
  return () => Promise.resolve(ks[i++] ?? null)
}

describe('select', () => {
  const options = [
    { label: 'claude', value: 'claude' },
    { label: 'codex', value: 'codex' },
    { label: 'opencode', value: 'opencode' },
  ]

  test('enter picks the first option', async () => {
    let out = ''
    const value = await select('Which harness?', options, keys([{ kind: 'enter' }]), (s) => {
      out += s
    })
    expect(value).toBe('claude')
    expect(out).toContain('> claude')
  })

  test('arrow keys move the highlight, wrapping top and bottom', async () => {
    let out = ''
    const value = await select(
      'Which harness?',
      options,
      keys([
        { kind: 'down' },
        { kind: 'down' },
        { kind: 'down' },
        { kind: 'up' },
        { kind: 'enter' },
      ]),
      (s) => {
        out += s
      },
    )
    expect(value).toBe('opencode')
    expect(out).toContain('> opencode')
  })

  test('escape cancels and returns null', async () => {
    const value = await select('Which harness?', options, keys([{ kind: 'cancel' }]), () => {})
    expect(value).toBeNull()
  })

  test('an empty list returns null without reading a key', async () => {
    const value = await select('Which harness?', [], keys([{ kind: 'enter' }]), () => {})
    expect(value).toBeNull()
  })
})

describe('input', () => {
  test('collects characters, backspace edits, enter returns', async () => {
    let out = ''
    const value = await input(
      'Model: ',
      keys([
        { kind: 'char', value: 'a' },
        { kind: 'char', value: 'b' },
        { kind: 'char', value: 'c' },
        { kind: 'backspace' },
        { kind: 'char', value: 'd' },
        { kind: 'enter' },
      ]),
      (s) => {
        out += s
      },
    )
    expect(value).toBe('abd')
    expect(out).toBe('Model: abc\b \bd\n')
  })

  test('escape cancels and returns null', async () => {
    const value = await input(
      'Model: ',
      keys([{ kind: 'char', value: 'x' }, { kind: 'cancel' }]),
      () => {},
    )
    expect(value).toBeNull()
  })
})
