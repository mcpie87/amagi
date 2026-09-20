import { type Config, HarnessConfig } from '@amagi/core'

const KINDS = ['claude', 'codex', 'opencode'] as const

export type SelectOption<T> = { label: string; value: T }

export type Picker = {
  select<T>(title: string, options: readonly SelectOption<T>[]): Promise<T | null>
  input(prompt: string): Promise<string | null>
}

export type RunSelection = {
  harness: Config['harness']['implement']
  interactive: boolean
}

/** Harness choices for the picker: named definitions, or the three known kinds. */
export function harnessChoices(config: Config): SelectOption<Config['harness']['implement']>[] {
  const defs = Object.entries(config.harness.definitions)
  if (defs.length > 0) {
    return defs.map(([name, cfg]) => ({ label: name, value: cfg }))
  }
  return KINDS.map((kind) => ({ label: kind, value: HarnessConfig.parse({ kind }) }))
}

const withModel = (
  cfg: Config['harness']['implement'],
  model: string | undefined,
): Config['harness']['implement'] => (model === undefined ? cfg : { ...cfg, model })

/**
 * Resolves the harness and model for a run. `--harness`/`--model` win and
 * never prompt; without flags a null picker (no TTY) falls back to the config
 * defaults; with a picker the operator chooses harness then model from a
 * cached model list.
 */
export async function pickRunSelection(
  config: Config,
  flags: { harness?: string; model?: string },
  picker: Picker | null,
  listModels: (cfg: Config['harness']['implement']) => Promise<string[]>,
): Promise<RunSelection> {
  if (flags.harness !== undefined) {
    const named = config.harness.definitions[flags.harness]
    const harness = named ?? HarnessConfig.parse({ kind: flags.harness })
    return { harness: withModel(harness, flags.model), interactive: false }
  }

  if (picker === null) {
    return { harness: withModel(config.harness.implement, flags.model), interactive: false }
  }

  const chosen = await picker.select('Which harness?', harnessChoices(config))
  if (chosen === null) {
    return { harness: withModel(config.harness.implement, flags.model), interactive: true }
  }
  if (flags.model !== undefined) {
    return { harness: withModel(chosen, flags.model), interactive: true }
  }

  const defaultModel = chosen.model
  const options: SelectOption<string | null>[] = []
  if (defaultModel !== undefined) {
    options.push({ label: `default (${defaultModel})`, value: defaultModel })
  }
  for (const m of await listModels(chosen)) {
    if (m !== defaultModel) options.push({ label: m, value: m })
  }
  options.push({ label: '(custom model)', value: '' })

  const picked = await picker.select('Which model?', options)
  let model: string | undefined
  if (picked === null) model = defaultModel
  else if (picked === '') model = (await picker.input('Model: ')) ?? defaultModel
  else model = picked
  return { harness: withModel(chosen, model), interactive: true }
}
