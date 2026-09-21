import { type Config, HARDCODED_EFFORTS, HarnessConfig } from '@amagi/core'

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

const withEffort = (
  cfg: Config['harness']['implement'],
  effort: string | undefined,
): Config['harness']['implement'] => (effort === undefined ? cfg : { ...cfg, effort })

/**
 * Resolves the harness, model and effort for a run. `--harness`/`--model`/
 * `--effort` win and never prompt; without flags a null picker (no TTY) falls
 * back to the config defaults; with a picker the operator chooses harness,
 * then model from a cached model list, then effort from the hardcoded
 * per-kind levels.
 */
export async function pickRunSelection(
  config: Config,
  flags: { harness?: string; model?: string; effort?: string },
  picker: Picker | null,
  listModels: (cfg: Config['harness']['implement']) => Promise<string[]>,
): Promise<RunSelection> {
  if (flags.harness !== undefined) {
    const named = config.harness.definitions[flags.harness]
    const harness = named ?? HarnessConfig.parse({ kind: flags.harness })
    return {
      harness: withEffort(withModel(harness, flags.model), flags.effort),
      interactive: false,
    }
  }

  if (picker === null) {
    return {
      harness: withEffort(withModel(config.harness.implement, flags.model), flags.effort),
      interactive: false,
    }
  }

  const chosen = await picker.select('Which harness?', harnessChoices(config))
  if (chosen === null) {
    return {
      harness: withEffort(withModel(config.harness.implement, flags.model), flags.effort),
      interactive: true,
    }
  }
  if (flags.model !== undefined || flags.effort !== undefined) {
    return {
      harness: withEffort(withModel(chosen, flags.model), flags.effort),
      interactive: true,
    }
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

  const chosenWithModel = withModel(chosen, model)
  const efforts = HARDCODED_EFFORTS[chosen.kind]
  if (efforts === undefined) {
    return { harness: chosenWithModel, interactive: true }
  }

  const defaultEffort = chosen.effort
  const effortOptions: SelectOption<string | null>[] = []
  if (defaultEffort !== undefined) {
    effortOptions.push({ label: `default (${defaultEffort})`, value: defaultEffort })
  }
  for (const e of efforts) {
    if (e !== defaultEffort) effortOptions.push({ label: e, value: e })
  }

  const pickedEffort = await picker.select('Which effort?', effortOptions)
  let effort: string | undefined
  if (pickedEffort === null) effort = defaultEffort
  else effort = pickedEffort
  return { harness: withEffort(chosenWithModel, effort), interactive: true }
}
