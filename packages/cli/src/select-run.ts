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

const withEffort = (
  cfg: Config['harness']['implement'],
  effort: string | undefined,
): Config['harness']['implement'] => (effort === undefined ? cfg : { ...cfg, effort })

/** Builds the "pick one of N or a custom value" prompt shared by model and effort. */
async function pickOne(
  picker: Picker,
  title: string,
  customLabel: string,
  value: string | undefined,
  options: readonly string[],
): Promise<string | undefined> {
  const list: SelectOption<string | null>[] = []
  if (value !== undefined) list.push({ label: `default (${value})`, value })
  for (const o of options) if (o !== value) list.push({ label: o, value: o })
  list.push({ label: customLabel, value: '' })

  const picked = await picker.select(title, list)
  if (picked === null) return value
  if (picked === '') return (await picker.input(`${title}: `)) ?? value
  return picked
}

/**
 * Resolves the harness, model and effort for a run. `--harness`/`--model`/
 * `--effort` win and never prompt; without flags a null picker (no TTY) falls
 * back to the config defaults; with a picker the operator chooses harness,
 * then model and effort from the harness's own lists.
 */
export async function pickRunSelection(
  config: Config,
  flags: { harness?: string; model?: string; effort?: string },
  picker: Picker | null,
  listModels: (cfg: Config['harness']['implement']) => Promise<string[]>,
  listEfforts: (cfg: Config['harness']['implement'], model?: string) => Promise<string[]>,
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
  if (flags.model !== undefined) {
    return {
      harness: withEffort(withModel(chosen, flags.model), flags.effort),
      interactive: true,
    }
  }

  const defaultModel = chosen.model
  const model = await pickOne(
    picker,
    'Which model?',
    '(custom model)',
    defaultModel,
    await listModels(chosen),
  )

  const picked = withModel(chosen, model)
  const efforts = await listEfforts(picked, model)
  const effort =
    flags.effort !== undefined
      ? flags.effort
      : picked.effort === undefined && efforts.length === 0
        ? undefined
        : await pickOne(picker, 'Which effort?', '(custom effort)', picked.effort, efforts)
  return { harness: withEffort(picked, effort), interactive: true }
}
