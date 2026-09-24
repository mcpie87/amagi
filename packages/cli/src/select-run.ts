import {
  type Config,
  HARDCODED_EFFORTS,
  resolveHarnessKind,
  resolveWorkerHarness,
  type StoredEvent,
  type WorkerConfig,
  workerSeat,
} from '@amagi/core'

const KINDS = ['claude', 'codex', 'opencode'] as const

export type SelectOption<T> = { label: string; value: T }

/** How many times each harness kind and model was actually run, from history. */
export type UsageCounts = { harness: Record<string, number>; model: Record<string, number> }

export function usageCounts(events: readonly StoredEvent[]): UsageCounts {
  const harness: Record<string, number> = {}
  const model: Record<string, number> = {}
  for (const event of events) {
    if (event.type !== 'agent.started') continue
    harness[event.harness] = (harness[event.harness] ?? 0) + 1
    if (event.model !== null) model[event.model] = (model[event.model] ?? 0) + 1
  }
  return { harness, model }
}

const emptyCounts = (): UsageCounts => ({ harness: {}, model: {} })

export type Picker = {
  select<T>(title: string, options: readonly SelectOption<T>[]): Promise<T | null>
  input(prompt: string): Promise<string | null>
}

export type RunSelection = {
  harness: Config['harness']['implement']
  interactive: boolean
}

/**
 * A bare-kind harness config (no named definition): the configured implement
 * harness when its kind matches, otherwise the kind's default. Lets the
 * implement harness's `bin` (e.g. a NixOS `opencode-unconfined` wrapper) carry
 * through to the picker and `--harness` flags instead of silently falling back
 * to the harness's stock binary, which may be a read-only sandbox.
 */
function bareKind(kind: (typeof KINDS)[number], config: Config): Config['harness']['implement'] {
  return resolveHarnessKind(config, kind)
}

export type WorkerRunSelection = {
  worker: WorkerConfig
  harness: Config['harness']['implement']
  interactive: boolean
}

export function workerChoices(config: Config): SelectOption<WorkerConfig>[] {
  return config.worker
    .filter((worker) => worker.enabled)
    .map((worker) => ({
      label: [
        `${worker.name} [${worker.id}]`,
        worker.kind,
        `model ${worker.model ?? 'default'}`,
        `effort ${worker.effort ?? 'default'}`,
        `seat ${workerSeat(worker)}`,
      ].join(' · '),
      value: worker,
    }))
}

/** Selects a fleet worker and resolves per-run overrides without persisting them. */
export async function pickWorkerSelection(
  config: Config,
  flags: { worker?: string; harness?: string; model?: string; effort?: string },
  picker: Picker | null,
): Promise<WorkerRunSelection> {
  const enabled = config.worker.filter((worker) => worker.enabled)
  const worker =
    flags.worker === undefined
      ? picker === null
        ? undefined
        : await picker.select('Which worker?', workerChoices(config))
      : config.worker.find((candidate) => candidate.id === flags.worker)

  if (flags.worker !== undefined && worker === undefined) {
    const exists = config.worker.some((candidate) => candidate.id === flags.worker)
    throw new Error(
      exists ? `worker "${flags.worker}" is disabled` : `unknown worker "${flags.worker}"`,
    )
  }
  if (worker !== undefined && worker !== null && !worker.enabled) {
    throw new Error(`worker "${worker.id}" is disabled`)
  }
  if (worker === null) throw new Error('worker selection cancelled')
  if (worker === undefined) {
    if (enabled.length === 0) throw new Error('no enabled workers are configured')
    throw new Error('amagi run needs a terminal or --worker <id>')
  }

  let kind: WorkerConfig['kind'] | undefined
  if (flags.harness !== undefined) {
    kind = KINDS.find((candidate) => candidate === flags.harness)
    if (kind === undefined) {
      throw new Error(`unknown harness "${flags.harness}"`)
    }
  }
  return {
    worker,
    harness: resolveWorkerHarness(config, worker, {
      ...(kind === undefined ? {} : { kind }),
      ...(flags.model === undefined ? {} : { model: flags.model }),
      ...(flags.effort === undefined ? {} : { effort: flags.effort }),
    }),
    interactive: flags.worker === undefined,
  }
}

/** Harness choices for the picker, most-used kind first. */
export function harnessChoices(
  config: Config,
  counts: UsageCounts = emptyCounts(),
): SelectOption<Config['harness']['implement']>[] {
  const byUsage = (
    a: SelectOption<Config['harness']['implement']>,
    b: SelectOption<Config['harness']['implement']>,
  ) => (counts.harness[b.value.kind] ?? 0) - (counts.harness[a.value.kind] ?? 0)
  return KINDS.map((kind) => ({ label: kind, value: bareKind(kind, config) })).sort(byUsage)
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
  counts: UsageCounts = emptyCounts(),
): Promise<RunSelection> {
  if (flags.harness !== undefined) {
    const known = KINDS.find((kind) => kind === flags.harness)
    const harness = known === undefined ? undefined : bareKind(known, config)
    if (harness === undefined) throw new Error(`unknown harness "${flags.harness}"`)
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

  const chosen = await picker.select('Which harness?', harnessChoices(config, counts))
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
  const listed = [...(await listModels(chosen))].sort(
    (a, b) => (counts.model[b] ?? 0) - (counts.model[a] ?? 0),
  )
  for (const m of listed) {
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
