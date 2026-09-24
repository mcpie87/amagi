import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import modelTable from './models.json' with { type: 'json' }
import { cacheHome } from './paths.ts'

/**
 * Curated model and effort options per harness kind, owned by amagi rather
 * than scraped from each CLI's own listing. A new model ships by editing
 * models.json, not by parsing `claude model list` or `~/.codex/config.toml`.
 * Only claude and codex are curated; opencode keeps listing its own models.
 */
type HarnessModelTable = Partial<Record<string, readonly string[]>> & {
  claude: readonly string[]
  codex: readonly string[]
}

const parsed = modelTable as {
  models: HarnessModelTable
  efforts: HarnessModelTable
}

export const HARDCODED_MODELS: HarnessModelTable = parsed.models

/**
 * Discrete reasoning-effort levels each harness accepts, keyed by kind. These
 * feed the interactive effort prompt in pickRunSelection; a harness with no
 * entry gets no prompt. Levels match what each CLI accepts: claude's effort
 * levels and codex's `model_reasoning_effort` values.
 */
export const HARDCODED_EFFORTS: HarnessModelTable = parsed.efforts

/** A model name as harnesses print it: provider-qualified or bare, no spaces. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-/]*$/

/** Column headers that would otherwise parse as model names. */
const HEADERS = new Set([
  'model',
  'models',
  'id',
  'name',
  'provider',
  'vendor',
  'api',
  'type',
  'context',
  'input',
  'output',
  'pricing',
  'cost',
  'price',
  'max',
  'tokens',
  'status',
  'streaming',
])

/**
 * Turns `opencode models`-style `provider/model` lines (or claude/codex model
 * table columns) into a de-duplicated model list. The first token of each line
 * that looks like a model name wins, so a table's trailing description columns
 * are ignored.
 */
export function parseModelLines(output: string): string[] {
  const seen = new Set<string>()
  const models: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^-{2,}$/.test(line)) continue
    for (const token of line.split(/\s+/)) {
      if (!MODEL_RE.test(token)) continue
      if (HEADERS.has(token.toLowerCase())) break
      if (!seen.has(token)) {
        seen.add(token)
        models.push(token)
      }
      break
    }
  }
  return models
}

/**
 * claude has no `model list` subcommand; its `/model` slash command works
 * non-interactively under `-p` and replies with e.g. "Usage: /model <name>.
 * Available: sonnet, opus, ..., or a full model ID." This pulls the names
 * out of that reply. The trailing "or a full model ID" is prose, not a
 * choice, so any comma-split entry containing whitespace is dropped.
 */
export function parseClaudeModelHint(output: string): string[] {
  const match = output.match(/Available:\s*(.+)/)
  if (!match?.[1]) return []
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter((s) => s !== '' && !/\s/.test(s))
}

const TTL_MS = 24 * 60 * 60 * 1000

type CacheEntry = { cachedAt: number; models: string[] }

/**
 * Returns curated models for claude/codex. Other harnesses use a per-kind
 * disk cache so the picker stays fast and works offline: a fresh cache wins,
 * a failed listing falls back to whatever is cached (even stale), and nothing
 * is cached until a listing actually succeeds.
 */
export async function listModelsCached(
  kind: string,
  list: () => Promise<string[]>,
  cacheDir = join(cacheHome(), 'amagi', 'models'),
): Promise<string[]> {
  const curated = HARDCODED_MODELS[kind]
  if (curated !== undefined) return [...curated]
  const file = join(cacheDir, `${kind}.json`)
  const read = (): CacheEntry | null => {
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as CacheEntry
    } catch {
      return null
    }
  }
  const cached = read()
  if (cached !== null && Date.now() - cached.cachedAt < TTL_MS) return cached.models

  try {
    const models = await list()
    if (models.length > 0) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cachedAt: Date.now(), models }))
    }
    return models
  } catch {
    return cached?.models ?? []
  }
}
