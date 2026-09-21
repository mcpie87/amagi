import { describe, expect, test } from 'bun:test'
import { Config } from '@amagi/core'
import type { Usage } from './picker-usage.ts'
import { harnessChoices, type Picker, pickRunSelection } from './select-run.ts'

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

  test('ranks definitions by usage of their kind, most-picked first', () => {
    const labels = harnessChoices(config(), { opencode: 3, claude: 1 }).map((o) => o.label)
    expect(labels).toEqual(['fast', 'careful'])
  })

  test('unknown counts keep the configured order', () => {
    const labels = harnessChoices(config(), { nope: 5 }).map((o) => o.label)
    expect(labels).toEqual(['fast', 'careful'])
  })

  test('ranks the bare kinds by usage', () => {
    const labels = harnessChoices(config({ definitions: {} }), { opencode: 3, claude: 1 }).map(
      (o) => o.label,
    )
    expect(labels).toEqual(['opencode', 'claude', 'codex'])
  })
})

describe('pickRunSelection', () => {
  const listModels = async () => ['opencode/big-pickle', 'opencode/ling-3.0-flash-fin-free']
  const listEfforts = async () => ['low', 'medium', 'high']

  test('a --harness definition name resolves without prompting', async () => {
    const { harness, interactive } = await pickRunSelection(
      config(),
      { harness: 'fast', model: 'opencode/other' },
      null,
      listModels,
      listEfforts,
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
      listEfforts,
    )
    expect(interactive).toBe(false)
    expect(harness).toMatchObject({ kind: 'claude' })
    expect(harness.permissions).toBe('workspace-write')
  })

  test('no tty and no flags keeps the configured implement harness', async () => {
    const { harness, interactive } = await pickRunSelection(
      config(),
      {},
      null,
      listModels,
      listEfforts,
    )
    expect(interactive).toBe(false)
    expect(harness.kind).toBe('claude')
  })

  test('interactive: picks harness, then a model from the listed options', async () => {
    const picker = scripted(['fast', 'opencode/big-pickle'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.kind).toBe('opencode')
    expect(harness.model).toBe('opencode/big-pickle')
  })

  test('interactive: a custom model is read from the prompt', async () => {
    const picker = scripted(['fast', '(custom model)'], ['local/some-model'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.model).toBe('local/some-model')
  })

  test('interactive: the picked default stays when the model pick is cancelled', async () => {
    const picker = scripted(['fast', null])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.model).toBe('local/deepseek-ai/DeepSeek-V4-Flash-0731')
  })

  test('interactive: cancelling the harness pick falls back to the configured default', async () => {
    const picker = scripted([null])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.kind).toBe('claude')
  })

  test('--model skips the model prompt after an interactive harness pick', async () => {
    const picker = scripted(['fast'])
    const { harness } = await pickRunSelection(
      config(),
      { model: 'opencode/forced' },
      picker,
      listModels,
      listEfforts,
    )
    expect(harness.model).toBe('opencode/forced')
  })

  test('interactive: picks an effort from the listed options', async () => {
    const picker = scripted(['fast', 'opencode/big-pickle', 'high'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.effort).toBe('high')
  })

  test('interactive: a custom effort is read from the prompt', async () => {
    const picker = scripted(['fast', 'opencode/big-pickle', '(custom effort)'], ['ultra'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, listEfforts)
    expect(harness.effort).toBe('ultra')
  })

  test('interactive: no effort options means no effort prompt', async () => {
    const noEfforts = async () => []
    const picker = scripted(['fast', 'opencode/big-pickle'])
    const { harness } = await pickRunSelection(config(), {}, picker, listModels, noEfforts)
    expect(harness.effort).toBeUndefined()
  })

  test('--effort skips the effort prompt after an interactive harness pick', async () => {
    const picker = scripted(['fast'])
    const { harness } = await pickRunSelection(
      config(),
      { effort: 'max' },
      picker,
      listModels,
      listEfforts,
    )
    expect(harness.effort).toBe('max')
  })

  test('run-history usage reorders harness and model options', async () => {
    const usage: Usage = { opencode: 3, 'opencode/big-pickle': 2 }
    const seen: string[][] = []
    const picker: Picker = {
      select: async (_title, options) => {
        seen.push(options.map((o) => o.label))
        return options.find((o) => o.label === 'fast')?.value ?? null
      },
      input: async () => null,
    }

    await pickRunSelection(config(), {}, picker, listModels, listEfforts, usage)
    expect(seen[0]).toEqual(['fast', 'careful'])
    expect(seen[1]?.indexOf('opencode/big-pickle')).toBe(0)
  })
})
