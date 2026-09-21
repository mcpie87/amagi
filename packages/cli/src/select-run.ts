import { type Config, HarnessConfig } from '@amagi/core'
import { byUsage, type Usage } from './picker-usage.ts'

const KINDS = ['claude', 'codex', 'opencode'] as const

const bump = (usage: Usage, label: string): void => {
  usage[label] = (usage[label] ?? 0) + 1
}

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
export function harnessChoices(
  config: Config,
  usage: Usage = {},
): SelectOption<Config['harness']['implement']>[] {
  const defs = Object.entries(config.harness.definitions)
  const base =
    defs.length > 0
      ? defs.map(([name, cfg]) => ({ label: name, value: cfg }))
      : KINDS.map((kind) => ({ label: kind, value: HarnessConfig.parse({ kind }) }))
  return byUsage(usage, base)
}

/** Label of a chosen harness: its definition name, else its bare kind. */
const harnessLabel = (config: Config, chosen: Config['harness']['implement']): string =>
  Object.entries(config.harness.definitions).find(([, cfg]) => cfg === chosen)?.[0] ?? chosen.kind

const withModel = (
  cfg: Config['harness']['implement'],
  model: string | undefined,
): Config['harness']['implement'] => (model === undefined ? cfg : { ...cfg, model })

/**
 * Resolves the harness and model for a run. `--harness`/`--model` win and
 * never prompt; without flags a null picker (no TTY) falls back to the config
 * defaults; with a picker the operator chooses harness then model from a
 * cached model list. Interactive picks are recorded into `usage` (label ->
 * pick count) so the most-chosen options rank first next time.
 */
export async function pickRunSelection(
  config: Config,
  flags: { harness?: string; model?: string },
  picker: Picker | null,
  listModels: (cfg: Config['harness']['implement']) => Promise<string[]>,
  usage: Usage = {},
): Promise<RunSelection> {
  if (flags.harness !== undefined) {
    const named = config.harness.definitions[flags.harness]
    const harness = named ?? HarnessConfig.parse({ kind: flags.harness })
    return { harness: withModel(harness, flags.model), interactive: false }
  }

  if (picker === null) {
    return { harness: withModel(config.harness.implement, flags.model), interactive: false }
  }

  const chosen = await picker.select('Which harness?', harnessChoices(config, usage))
  if (chosen === null) {
    return { harness: withModel(config.harness.implement, flags.model), interactive: true }
  }
  bump(usage, harnessLabel(config, chosen))
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

  const picked = await picker.select('Which model?', byUsage(usage, options))
  let model: string | undefined
  if (picked === null) {
    model = defaultModel
    if (defaultModel !== undefined) bump(usage, `default (${defaultModel})`)
  } else if (picked === '') {
    const typed = await picker.input('Model: ')
    model = typed ?? defaultModel
    if (typed !== null && model !== undefined) bump(usage, model)
  } else {
    model = picked
    bump(usage, picked)
  }
  return { harness: withModel(chosen, model), interactive: true }
}
