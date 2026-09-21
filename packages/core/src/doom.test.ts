import { describe, expect, test } from 'bun:test'
import { checkFailureSignature, detectDoom, toolSignature } from './doom.ts'
import type { StoredEvent } from './events.ts'

const now = 1_700_000_000_000
const OPTS = { toolWindowMs: 600_000, toolRepeat: 3, checkRounds: 3 }

const stream = (
  events: Array<{ kind: 'tool_use'; name: string; input: unknown } | { kind: 'text' }>,
  ts = now,
): StoredEvent[] =>
  events.map((e, i) => ({
    seq: i + 1,
    ts,
    taskId: 'bd-1',
    type: 'agent.stream',
    role: 'implement',
    event: e.kind === 'tool_use' ? e : { kind: 'text', text: 'hi' },
  })) as StoredEvent[]

const checks = (results: Array<[command: string, exitCode: number]>, ts = now): StoredEvent => ({
  seq: 1,
  ts,
  taskId: 'bd-1',
  type: 'checks.finished',
  ok: results.every(([, c]) => c === 0),
  results: results.map(([command, exitCode]) => ({ command, exitCode, output: '' })),
})

describe('toolSignature', () => {
  test('keys on the primary operand, collapsing whitespace', () => {
    expect(toolSignature('Bash', { command: 'bun test\n' })).toBe('Bash:bun test')
    expect(toolSignature('Bash', { command: 'bun  test' })).toBe('Bash:bun test')
  })

  test('file tools key on the file, not the content', () => {
    expect(toolSignature('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })).toBe(
      'Edit:src/a.ts',
    )
    expect(toolSignature('Read', { file_path: 'src/a.ts' })).toBe('Read:src/a.ts')
  })

  test('rejects calls with no comparable operand', () => {
    expect(toolSignature('Task', { description: 'think' })).toBeNull()
    expect(toolSignature('Bash', {})).toBeNull()
  })
})

describe('checkFailureSignature', () => {
  test('is null when everything passes', () => {
    expect(checkFailureSignature([{ command: 'just check', exitCode: 0, output: '' }])).toBeNull()
  })

  test('joins failing commands with their exit code, order independent', () => {
    const a = checkFailureSignature([
      { command: 'just lint', exitCode: 1, output: '' },
      { command: 'bun test', exitCode: 2, output: '' },
    ])
    const b = checkFailureSignature([
      { command: 'bun test', exitCode: 2, output: '' },
      { command: 'just lint', exitCode: 1, output: '' },
    ])
    expect(a).toBe('bun test:2 | just lint:1')
    expect(b).toBe(a)
  })
})

describe('detectDoom', () => {
  test('repeated identical tool calls within the window trip the guard', () => {
    const events = stream([
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
    ])
    expect(detectDoom(events, now, OPTS)).toEqual({
      kind: 'tool_repeat',
      detail: 'Bash:bun test x3',
    })
  })

  test('different commands do not trip the guard', () => {
    const events = stream([
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'just lint' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
    ])
    expect(detectDoom(events, now, OPTS)).toBeNull()
  })

  test('tool calls outside the sliding window do not count', () => {
    const events = [
      ...stream(
        [{ kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } }],
        now - 700_000,
      ),
      ...stream(
        [
          { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
          { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
        ],
        now,
      ),
    ]
    expect(detectDoom(events, now, OPTS)).toBeNull()
  })

  test('chat-stream tool calls are ignored', () => {
    const events = stream([
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
      { kind: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
    ]).map((e) => ({ ...e, role: 'chat' }) as StoredEvent)
    expect(detectDoom(events, now, OPTS)).toBeNull()
  })

  test('consecutive check rounds with the same failure signature trip the guard', () => {
    const events = [
      checks([['just check', 1]]),
      checks([['just check', 1]]),
      checks([['just check', 1]]),
    ]
    expect(detectDoom(events, now, OPTS)).toMatchObject({
      kind: 'check_repeat',
      detail: expect.stringContaining('just check:1'),
    })
  })

  test('a passing round resets the check streak', () => {
    const events = [
      checks([['just check', 1]]),
      checks([['just check', 0]]),
      checks([['just check', 1]]),
    ]
    expect(detectDoom(events, now, OPTS)).toBeNull()
  })

  test('a different failure signature resets the check streak', () => {
    const events = [
      checks([['just check', 1]]),
      checks([['bun test', 1]]),
      checks([['bun test', 1]]),
    ]
    expect(detectDoom(events, now, OPTS)).toBeNull()
  })

  test('returns null for an empty or quiet stream', () => {
    expect(detectDoom([], now, OPTS)).toBeNull()
    expect(detectDoom(stream([{ kind: 'text' }]), now, OPTS)).toBeNull()
  })
})
