import { describe, expect, test } from 'bun:test'
import { OpenCodeHarness, OpenCodeTranslator } from './opencode.ts'

describe('OpenCodeTranslator', () => {
  test('normalizes OpenCode JSON events', () => {
    const translator = new OpenCodeTranslator()
    const text = translator.push({
      type: 'text',
      sessionID: 'ses_123',
      part: { type: 'text', text: 'Done.' },
    })
    const tool = translator.push({
      type: 'tool_use',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'true' }, output: 'ok' },
      },
    })
    const usage = translator.push({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { input: 10, output: 4, reasoning: 2 }, cost: 0.01 },
    })

    expect(text).toEqual([{ kind: 'text', text: 'Done.' }])
    expect(tool).toEqual([
      { kind: 'tool_use', name: 'bash', input: { command: 'true' } },
      { kind: 'tool_result', name: 'bash', ok: true, output: 'ok' },
    ])
    expect(usage).toEqual([{ kind: 'usage', inputTokens: 10, outputTokens: 6, costUsd: 0.01 }])
    expect(translator.sessionId).toBe('ses_123')
  })
})

describe('OpenCodeHarness argv', () => {
  const base = { cwd: '/wt', prompt: 'do the thing' }

  test('uses OpenCode JSON streaming', () => {
    const argv = new OpenCodeHarness().argv(base, null)
    expect(argv.slice(0, 4)).toEqual(['opencode', 'run', '--format', 'json'])
  })

  test('forwards model, variant, and session', () => {
    const argv = new OpenCodeHarness().argv(
      { ...base, model: 'local/model', effort: 'high' },
      'ses_123',
    )
    expect(argv[argv.indexOf('--model') + 1]).toBe('local/model')
    expect(argv[argv.indexOf('--variant') + 1]).toBe('high')
    expect(argv[argv.indexOf('--session') + 1]).toBe('ses_123')
  })

  test('auto-approves only when bypass is selected', () => {
    expect(new OpenCodeHarness().argv(base, null)).not.toContain('--auto')
    expect(new OpenCodeHarness().argv({ ...base, permissions: 'bypass' }, null)).toContain('--auto')
  })

  test('uses the configured binary', () => {
    expect(new OpenCodeHarness({ bin: 'opencode-unconfined' }).argv(base, null)[0]).toBe(
      'opencode-unconfined',
    )
  })
})
