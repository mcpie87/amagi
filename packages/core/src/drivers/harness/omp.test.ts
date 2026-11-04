import { describe, expect, test } from 'bun:test'
import { OmpHarness, OmpTranslator, parseOmpModels } from './omp.ts'

describe('OmpHarness argv', () => {
  test('uses machine-readable launch, stdin prompt, requested controls, and continuation', () => {
    const harness = new OmpHarness({ bin: 'omp-test' })
    const opts = {
      cwd: '/work/tree',
      prompt: 'do it',
      systemPrompt: 'rules',
      model: 'vendor/model',
      effort: 'high',
      permissions: 'read-only' as const,
    }
    expect(harness.argv(opts, null)).toEqual([
      'omp-test',
      '-p',
      '--mode',
      'json',
      '--cwd',
      '/work/tree',
      '--model',
      'vendor/model',
      '--thinking',
      'high',
      '--append-system-prompt',
      'rules',
      '--approval-mode',
      'always-ask',
    ])
    expect(harness.argv(opts, 'session-1')).toContain('-r')
    expect(harness.argv(opts, 'session-1')).toContain('session-1')
  })
  test('maps unattended write and bypass policies to supported modes', () => {
    const harness = new OmpHarness()
    const opts = { cwd: '/work/tree', prompt: 'do it' }
    expect(harness.argv({ ...opts, permissions: 'workspace-write' }, null)).toEqual(
      expect.arrayContaining(['--approval-mode', 'write']),
    )
    expect(harness.argv({ ...opts, permissions: 'bypass' }, null)).toEqual(
      expect.arrayContaining(['--approval-mode', 'yolo']),
    )
  })
})

describe('OmpTranslator', () => {
  test('translates OMP JSON mode events and ignores unknown events', () => {
    const translator = new OmpTranslator()
    expect(translator.push({ type: 'header', id: 's1' })).toEqual([])
    expect(translator.sessionId).toBe('s1')
    expect(
      translator.push({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
      }),
    ).toEqual([{ kind: 'text', text: 'hello' }])
    expect(
      translator.push({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'a' },
      }),
    ).toEqual([{ kind: 'tool_use', name: 'read', input: { path: 'a' } }])
    expect(translator.push({ type: 'not-known' })).toEqual([])
    expect(translator.push({ type: 'agent_end', messages: [] })).toEqual([
      { kind: 'result', ok: true, summary: 'hello' },
    ])
    expect(translator.finalize()).toEqual([{ kind: 'result', ok: true, summary: 'hello' }])
  })
  test('selects model selectors from the JSON catalog, not display labels', () => {
    expect(
      parseOmpModels(
        JSON.stringify({
          models: [
            { selector: 'provider/model', name: 'Friendly name' },
            { name: 'missing selector' },
          ],
        }),
      ),
    ).toEqual(['provider/model'])
  })
})
