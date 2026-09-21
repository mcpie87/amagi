import { describe, expect, test } from 'bun:test'
import { AgentLogBuffer, AgentLogStore, linesForAgentEvent } from './agent-log.ts'

describe('linesForAgentEvent', () => {
  test('splits a multi-line text chunk into one row per line', () => {
    expect(linesForAgentEvent({ kind: 'text', text: 'a\nb\nc' })).toEqual(['a', 'b', 'c'])
  })

  test('drops the trailing empty element from a trailing newline', () => {
    expect(linesForAgentEvent({ kind: 'text', text: 'a\nb\n' })).toEqual(['a', 'b'])
  })

  test('marks failed tool_result lines', () => {
    const lines = linesForAgentEvent({
      kind: 'tool_result',
      name: 'Bash',
      ok: false,
      output: 'boom\ntrace',
    })
    expect(lines).toEqual(['! boom', '! trace'])
  })

  test('formats tool_use as a single row', () => {
    const lines = linesForAgentEvent({ kind: 'tool_use', name: 'Read', input: { path: 'x.ts' } })
    expect(lines).toEqual(['Read {"path":"x.ts"}'])
  })

  test('formats usage with and without cost', () => {
    expect(linesForAgentEvent({ kind: 'usage', inputTokens: 10, outputTokens: 20 })).toEqual([
      'tokens in=10 out=20',
    ])
    expect(
      linesForAgentEvent({ kind: 'usage', inputTokens: 10, outputTokens: 20, costUsd: 0.005 }),
    ).toEqual(['tokens in=10 out=20 cost=$0.0050'])
  })
})

describe('AgentLogBuffer', () => {
  test('reads back lines in insertion order', () => {
    const buffer = new AgentLogBuffer()
    buffer.push('implement', 1, 'text', 'first')
    buffer.push('implement', 2, 'text', 'second')
    expect(buffer.length).toBe(2)
    expect(buffer.at(0)?.text).toBe('first')
    expect(buffer.at(1)?.text).toBe('second')
  })

  test('wraps once past capacity, dropping the oldest lines', () => {
    const buffer = new AgentLogBuffer()
    const capacity = 4000
    for (let i = 0; i < capacity + 10; i++) {
      buffer.push('implement', i, 'text', `line-${i}`)
    }
    expect(buffer.length).toBe(capacity)
    expect(buffer.at(0)?.text).toBe('line-10')
    expect(buffer.at(capacity - 1)?.text).toBe(`line-${capacity + 9}`)
  })

  test('assigns ids that stay stable and increasing across a wrap', () => {
    const buffer = new AgentLogBuffer()
    for (let i = 0; i < 4010; i++) buffer.push('implement', i, 'text', `line-${i}`)
    const first = buffer.at(0)?.id
    const last = buffer.at(buffer.length - 1)?.id
    expect(first).toBeLessThan(last ?? 0)
  })

  test('out-of-range reads return undefined', () => {
    const buffer = new AgentLogBuffer()
    buffer.push('implement', 1, 'text', 'only')
    expect(buffer.at(-1)).toBeUndefined()
    expect(buffer.at(1)).toBeUndefined()
  })
})

describe('AgentLogStore', () => {
  test('appends never notify synchronously; only the scheduled flush does', () => {
    const scheduled: Array<() => void> = []
    const store = new AgentLogStore((cb) => {
      scheduled.push(cb)
    })
    let notified = 0
    store.subscribe('am-1', () => {
      notified++
    })

    store.append('am-1', 'implement', 1, { kind: 'text', text: 'a\nb\nc' })
    expect(notified).toBe(0)
    expect(store.get('am-1').length).toBe(3)

    scheduled[0]?.()
    expect(notified).toBe(1)
  })

  test('collapses many appends within one frame into a single flush per task', () => {
    const scheduled: Array<() => void> = []
    const store = new AgentLogStore((cb) => {
      scheduled.push(cb)
    })
    let notifiedA = 0
    let notifiedB = 0
    store.subscribe('am-1', () => {
      notifiedA++
    })
    store.subscribe('am-2', () => {
      notifiedB++
    })

    for (let i = 0; i < 200; i++) {
      store.append('am-1', 'implement', i, { kind: 'text', text: `line-${i}` })
    }
    store.append('am-2', 'implement', 0, { kind: 'text', text: 'other task' })

    scheduled[0]?.()
    expect(notifiedA).toBe(1)
    expect(notifiedB).toBe(1)
    expect(store.get('am-1').length).toBe(200)
  })

  test('a second scheduling cycle only fires after the previous flush ran', () => {
    const scheduled: Array<() => void> = []
    const store = new AgentLogStore((cb) => {
      scheduled.push(cb)
    })

    store.append('am-1', 'implement', 1, { kind: 'text', text: 'a' })
    store.append('am-1', 'implement', 2, { kind: 'text', text: 'b' })
    expect(scheduled.length).toBe(1)

    scheduled[0]?.()
    store.append('am-1', 'implement', 3, { kind: 'text', text: 'c' })
    expect(scheduled.length).toBe(2)
  })

  test('isolates buffers per task', () => {
    const scheduled: Array<() => void> = []
    const store = new AgentLogStore((cb) => {
      scheduled.push(cb)
    })
    store.append('am-1', 'implement', 1, { kind: 'text', text: 'one' })
    store.append('am-2', 'chat', 1, { kind: 'text', text: 'two' })
    scheduled[0]?.()

    expect(store.get('am-1').length).toBe(1)
    expect(store.get('am-2').length).toBe(1)
    expect(store.get('am-1').at(0)?.text).toBe('one')
    expect(store.get('am-2').at(0)?.role).toBe('chat')
  })
})
