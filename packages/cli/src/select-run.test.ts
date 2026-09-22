import { describe, expect, test } from 'bun:test'
import { Config } from '@amagi/core'
import { harnessChoices, type Picker, pickRunSelection, usageCounts } from './select-run.ts'

const started = (seq: number, harness: string, model: string | null = null) => ({
  seq,
  ts: seq,
  taskId: `am-${seq}`,
  type: 'agent.started' as const,
  role: 'implement' as const,
  harness,
  model,
  effort: null,
  cwd: '.',
  resumed: false,
})

const config = (over: Record<string, unknown> = {}) =>
  Config.parse({
    harness: {
      definitions: {
        fast: {
          kind: 'opencode',
          model: 'local/deepseek-ai/DeepSeek-V4-Flash-0731',
          permissions: 'bypass',
        },
        careful: { kind: 'claude' },
      },
      ...over,
    },
  })

const scripted = (selects: (string | null)[], inputs: (string | null)[] = []): Picker => {
  let s = 0
  let i = 0
  return {
    select: async (_title, options) => {
      const v = selects[s++]
      return options.find((o) => o.label === v)?.value ?? null
    },
    input: async () => inputs[i++] ?? null,
  }
}

describe('harnessChoices', () => {
  test('offers the named definitions when present', () => {
    const labels = harnessChoices(config()).map((o) => o.label)
    expect(labels).toEqual(['fast', 'careful'])
  })

  test('falls back to the three known kinds', () => {
    const labels = harnessChoices(config({ definitions: {} })).map((o) => o.label)
    expect(labels).toEqual(['claude', 'codex', 'opencode'])
  })

  test('fallback kind matching the implement harness keeps its bin', () => {
    const choices = harnessChoices(
      config({
        definitions: {},
        implement: { kind: 'opencode', bin: 'opencode-unconfined', permissions: 'bypass' },
      }),
    )
    const opencode = choices.find((o) => o.label === 'opencode')
    expect(opencode?.value).toMatchObject({
      kind: 'opencode',
      bin: 'opencode-unconfined',
      permissions: 'bypass',
    })
  })

  test('sorts definitions by how often their kind was used', () => {
    const counts = usageCounts([
      started(1, 'claude', 'sonnet'),
      started(2, 'claude', 'sonnet'),
      started(3, 'opencode', 'local/x'),
    ])
    const labels = harnessChoices(config(), counts).map((o) => o.label)
    expect(labels).toEqual(['careful', 'fast'])
  })

  test('sorts the fallback kinds by usage, ties keep insertion order', () => {
    const counts = usageCounts([started(1, 'codex'), started(2, 'codex'), started(3, 'claude')])
    const labels = harnessChoices(config({ definitions: {} }), counts).map((o) => o.label)
    expect(labels).toEqual(['codex', 'claude', 'opencode'])
  })
})

describe('usageCounts', () => {
  test('counts started runs per harness kind and model', () => {
    const counts = usageCounts([
      started(1, 'claude', 'sonnet'),
      started(2, 'claude', 'sonnet'),
      started(3, 'codex', 'gpt-5.1-codex'),
      started(4, 'opencode'),
    ])
    expect(counts).toEqual({
      harness: { claude: 2, codex: 1, opencode: 1 },
      model: { sonnet: 2, 'gpt-5.1-codex': 1 },
    })
  })
})

describe('pickRunSelection', () => {
  const listModels = async () => ['opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free']

  test('a --harness definition name resolves without prompting', async () => {
    const { harness, interactive } = await pickRunSelection(
      config(),
      { harness: 'fast', model: 'opencode/other' },
      null,
      listModels,
    )
    expect(interactive).toBe(false)
    expect(harness.kind).toBe('opencode')
    expect(harness.model).toBe('opencode/other')
    expect(harness.permissions).toBe('bypass')
  })

  test('a --harness bare kind builds a config without prompting', async () => {
    const { harness, interactive } = await pickRunSelection(
      config(),
      { harness: 'claude' },
      null,
      listModels,
    )
    expect(interactive).toBe(false)
    expect(harness).toMatchObject({ kind: 'claude' })
    expect(harness.permissions).toBe('workspace-write')
  })

  test('a --harness bare kind inherits the implement bin for its kind', async () => {
    const cfg = config({
      implement: { kind: 'opencode', bin: 'opencode-unconfined', permissions: 'bypass' },
    })
    const { harness } = await pickRunSelection(cfg, { harness: 'opencode' }, null, listModels)
    expect(harness).toMatchObject({
      kind: 'opencode',
      bin: 'opencode-unconfined',
      permissions: 'bypass',
    })
  })

  test('a --harness unknown kind is rejected', async () => {
    await expect(pickRunSelection(config(), { harness: 'nope' }, null, listModels)).rejects.toThrow(
      'unknown harness "nope"',
    )
  })

  test('no tty and no flags keeps the configured implement harness', async () => {
    const { harness, interactive } = await pickRunSelection(config(), {}, null, listModels)
    expect(interactive).toBe(false)
    expect(harness.kind).toBe('claude')
  })

  test('interactive: picks harness, then a model from the listed options', async () => {
    const picker = scripted(['fast', 'opencode/big-pickle'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels)
    expect(harness.kind).toBe('opencode')
    expect(harness.model).toBe('opencode/big-pickle')
  })

  test('interactive: a custom model is read from the prompt', async () => {
    const picker = scripted(['fast', '(custom model)'], ['local/some-model'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels)
    expect(harness.model).toBe('local/some-model')
  })

  test('interactive: the picked default stays when the model pick is cancelled', async () => {
    const picker = scripted(['fast', null])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels)
    expect(harness.model).toBe('local/deepseek-ai/DeepSeek-V4-Flash-0731')
  })

  test('interactive: model options are sorted by how often each was used', async () => {
    let modelLabels: string[] = []
    const picker: Picker = {
      select: async (title, options) => {
        if (title === 'Which harness?') {
          return options.find((o) => o.label === 'careful')?.value ?? null
        }
        if (title === 'Which model?') {
          modelLabels = options.map((o) => o.label)
          return null
        }
        return null
      },
      input: async () => null,
    }
    const counts = usageCounts([
      started(1, 'claude', 'sonnet'),
      started(2, 'claude', 'sonnet'),
      started(3, 'claude', 'sonnet'),
      started(4, 'claude', 'opus'),
    ])
    await pickRunSelection(config(), {}, picker, async () => ['opus', 'haiku', 'sonnet'], counts)
    expect(modelLabels).toEqual(['sonnet', 'opus', 'haiku', '(custom model)'])
  })

  test('interactive: cancelling the harness pick falls back to the configured default', async () => {
    const picker = scripted([null])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels)
    expect(harness.kind).toBe('claude')
  })

  test('interactive: --model skips the model prompt after an interactive harness pick', async () => {
    const picker = scripted(['fast'])
    const { harness } = await pickRunSelection(
      config(),
      { model: 'opencode/forced' },
      picker,
      listModels,
    )
    expect(harness.model).toBe('opencode/forced')
  })

  test('interactive: picks harness, model, then effort from the hardcoded levels', async () => {
    const picker = scripted(['careful', 'sonnet', 'high'])
    const claudeModels = async () => ['sonnet', 'opus', 'haiku']
    const { harness } = await pickRunSelection(config(), {}, picker, claudeModels)
    expect(harness.kind).toBe('claude')
    expect(harness.model).toBe('sonnet')
    expect(harness.effort).toBe('high')
  })

  test('interactive: cancelling the effort pick keeps the configured default', async () => {
    const withEffort = config({
      definitions: { careful: { kind: 'claude', effort: 'medium' } },
    })
    const picker = scripted(['careful', 'sonnet', null])
    const claudeModels = async () => ['sonnet', 'opus', 'haiku']
    const { harness } = await pickRunSelection(withEffort, {}, picker, claudeModels)
    expect(harness.effort).toBe('medium')
  })

  test('interactive: opencode gets no effort prompt', async () => {
    const picker = scripted(['fast', 'opencode/big-pickle'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels)
    expect(harness.kind).toBe('opencode')
    expect(harness.effort).toBeUndefined()
  })

  test('--effort is applied without prompting', async () => {
    const picker = scripted(['careful'])
    const { harness } = await pickRunSelection(config(), { effort: 'high' }, picker, listModels)
    expect(harness.kind).toBe('claude')
    expect(harness.effort).toBe('high')
  })

  test('--effort with no tty falls through to the config harness', async () => {
    const { harness } = await pickRunSelection(config(), { effort: 'xhigh' }, null, listModels)
    expect(harness.kind).toBe('claude')
    expect(harness.effort).toBe('xhigh')
  })
})
