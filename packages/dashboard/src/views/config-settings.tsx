import {
  EDITABLE_SETTINGS,
  type EditableSetting,
  type EditableSettingPath,
} from '@amagi/core/settings'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { card, field, input, ListEditor, secondary } from './settings-ui.tsx'

type Values = Record<EditableSettingPath, unknown>
type ConfigView = {
  values: Values
  server: { host: string; port: number }
  personas: string[]
  running: boolean
}

type Harness = {
  kind: string
  seat?: string
  bin?: string | string[]
  model?: string
  effort?: string
  permissions?: string
  allowedTools?: string[]
  extraArgs?: string[]
}

type Group =
  | 'Repository'
  | 'Review'
  | 'Checks and run limits'
  | 'Watcher intervals'
  | 'Stall and doom-loop guard'
  | 'Questions and retries'
  | 'Context budget'
  | 'Notifications'
  | 'Mentions and difficulty (all repositories)'
  | 'Harnesses (all repositories)'

type Field = { group: Group; label: string; help?: string } & (
  | { kind: 'bool' | 'int' | 'number' | 'text' | 'optionalText' | 'list' | 'persona' }
  | { kind: 'select'; options: readonly string[] }
  | { kind: 'harness'; optional?: true }
  | { kind: 'harnesses' | 'contextOverrides' }
)

const HARNESS_KINDS = ['claude', 'codex', 'opencode'] as const

const FIELDS: Record<EditableSettingPath, Field> = {
  'repo.baseBranch': { group: 'Repository', label: 'Base branch', kind: 'text' },
  'repo.worktreeRoot': { group: 'Repository', label: 'Worktree root', kind: 'text' },
  'repo.setupCmd': {
    group: 'Repository',
    label: 'Setup command',
    help: 'Runs in every fresh worktree before the agent starts.',
    kind: 'optionalText',
  },
  'repo.persona': {
    group: 'Repository',
    label: 'Git persona',
    help: 'Identity fragment under ~/.config/git/personas applied to worktrees.',
    kind: 'persona',
  },
  'tracker.kind': {
    group: 'Repository',
    label: 'Tracker',
    kind: 'select',
    options: ['beads', 'github', 'forgejo'],
  },
  'forge.agentHandle': {
    group: 'Repository',
    label: 'Agent handle',
    help: 'Forge user (without @) whose mentions trigger responses.',
    kind: 'text',
  },
  'checks.commands': {
    group: 'Checks and run limits',
    label: 'Extra check commands',
    help: 'Run after format, lint and test.',
    kind: 'list',
  },
  'checks.timeoutSec': {
    group: 'Checks and run limits',
    label: 'Check timeout, seconds',
    help: 'A check still running after this is killed and counts as failed.',
    kind: 'int',
  },
  'loop.maxCheckRounds': {
    group: 'Checks and run limits',
    label: 'Check fix rounds',
    kind: 'int',
  },
  'loop.maxRunMinutes': {
    group: 'Checks and run limits',
    label: 'Max run minutes (0 = unbounded)',
    kind: 'int',
  },
  'loop.maxCostUsd': {
    group: 'Checks and run limits',
    label: 'Max cost per task, USD (0 = unbounded)',
    kind: 'number',
  },
  'loop.autoQueueIdleSec': {
    group: 'Checks and run limits',
    label: 'Auto queue idle poll, seconds',
    kind: 'int',
  },
  'loop.conflictMaxIterations': {
    group: 'Checks and run limits',
    label: 'Conflict resolutions per PR',
    kind: 'int',
  },
  'loop.mergeTreeCheck': {
    group: 'Checks and run limits',
    label: 'Merge-tree audit',
    help: 'Logs local merge-tree verdicts next to the forge’s; changes no behaviour.',
    kind: 'bool',
  },
  'review.harness': {
    group: 'Review',
    label: 'Reviewer harness',
    help: 'Unset picks a reviewer worker or an installed harness other than the implementer.',
    kind: 'harness',
    optional: true,
  },
  'review.threshold': {
    group: 'Review',
    label: 'Blocking severity',
    kind: 'select',
    options: ['blocker', 'major', 'minor', 'nit'],
  },
  'review.finalPass': { group: 'Review', label: 'Final clean pass', kind: 'bool' },
  'review.maxTokens': { group: 'Review', label: 'Review token budget', kind: 'int' },
  'review.lenses': { group: 'Review', label: 'Review lenses', kind: 'list' },
  'loop.mentionWatchIntervalSec': {
    group: 'Watcher intervals',
    label: 'Mention watcher, seconds',
    kind: 'int',
  },
  'loop.prCheckIntervalSec': {
    group: 'Watcher intervals',
    label: 'PR conflict watcher, seconds',
    kind: 'int',
  },
  'loop.stallWatchIntervalSec': {
    group: 'Watcher intervals',
    label: 'Stall watcher, seconds',
    kind: 'int',
  },
  'loop.epicCloseIntervalSec': {
    group: 'Watcher intervals',
    label: 'Epic close, seconds',
    kind: 'int',
  },
  'loop.beadsGcIntervalSec': {
    group: 'Watcher intervals',
    label: 'Beads garbage collection, seconds',
    kind: 'int',
  },
  'loop.stallTimeoutSec': {
    group: 'Stall and doom-loop guard',
    label: 'Stall timeout, seconds',
    kind: 'int',
  },
  'loop.doomEnabled': {
    group: 'Stall and doom-loop guard',
    label: 'Doom-loop guard',
    kind: 'bool',
  },
  'loop.doomToolWindowSec': {
    group: 'Stall and doom-loop guard',
    label: 'Repeated tool window, seconds',
    kind: 'int',
  },
  'loop.doomToolRepeat': {
    group: 'Stall and doom-loop guard',
    label: 'Repeated tool calls that trip it',
    kind: 'int',
  },
  'loop.doomCheckRounds': {
    group: 'Stall and doom-loop guard',
    label: 'Same-failure check rounds that trip it',
    kind: 'int',
  },
  'loop.doomDiffWindowSec': {
    group: 'Stall and doom-loop guard',
    label: 'Unchanged diff window, seconds',
    kind: 'int',
  },
  'loop.questionTimeoutSec': {
    group: 'Questions and retries',
    label: 'Question poll timeout, seconds',
    kind: 'int',
  },
  'loop.questionParkTimeoutSec': {
    group: 'Questions and retries',
    label: 'Parked question timeout, seconds',
    kind: 'int',
  },
  'loop.maxRetries': { group: 'Questions and retries', label: 'Transient retries', kind: 'int' },
  'loop.retryBaseMs': { group: 'Questions and retries', label: 'Retry base, ms', kind: 'int' },
  'loop.retryMaxMs': { group: 'Questions and retries', label: 'Retry cap, ms', kind: 'int' },
  'loop.contextWarnTokens': { group: 'Context budget', label: 'Warn at tokens', kind: 'int' },
  'loop.contextMaxTokens': { group: 'Context budget', label: 'Restart at tokens', kind: 'int' },
  'loop.contextMaxRestarts': {
    group: 'Context budget',
    label: 'Fresh-context restarts',
    kind: 'int',
  },
  'loop.contextOverrides': {
    group: 'Context budget',
    label: 'Per-harness overrides',
    kind: 'contextOverrides',
  },
  'notify.idle': { group: 'Notifications', label: 'Idle notifications', kind: 'bool' },
  'notify.desktop': { group: 'Notifications', label: 'Desktop notifications', kind: 'bool' },
  'watchers.mention.allowedAuthors': {
    group: 'Mentions and difficulty (all repositories)',
    label: 'Mention authors allowed to trigger agents',
    help: 'Empty lets nobody trigger the mention watcher.',
    kind: 'list',
  },
  'watchers.beadsGc.enabled': {
    group: 'Mentions and difficulty (all repositories)',
    label: 'Beads garbage collection',
    kind: 'bool',
  },
  'difficulty.enabled': {
    group: 'Mentions and difficulty (all repositories)',
    label: 'Difficulty triage',
    kind: 'bool',
  },
  'difficulty.levels': {
    group: 'Mentions and difficulty (all repositories)',
    label: 'Difficulty levels',
    kind: 'list',
  },
  'harness.implement': {
    group: 'Harnesses (all repositories)',
    label: 'Implement role',
    kind: 'harness',
  },
  'harness.triage': {
    group: 'Harnesses (all repositories)',
    label: 'Triage role',
    kind: 'harness',
  },
  'harness.definitions': {
    group: 'Harnesses (all repositories)',
    label: 'Named definitions (amagi run picker)',
    kind: 'harnesses',
  },
}

const GROUPS = [...new Set(Object.values(FIELDS).map((f) => f.group))]
const RULES = new Map<string, EditableSetting>(
  EDITABLE_SETTINGS.map((setting): [string, EditableSetting] => [setting.path, setting]),
)

/** Every setting without a dedicated control elsewhere in Settings, grouped into cards. */
export function ConfigSettings({ repo }: { repo: string }) {
  const [view, setView] = useState<ConfigView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setView(null)
    setError(null)
    fetch(`${apiBase}/api/repos/${encodeURIComponent(repo)}/config`)
      .then(async (res) => {
        if (!res.ok)
          throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`)
        return res.json() as Promise<ConfigView>
      })
      .then((loaded) => {
        if (active) setView(loaded)
      })
      .catch((err: unknown) => {
        if (active)
          setError(err instanceof Error ? err.message : 'could not reach the amagi server')
      })
    return () => {
      active = false
    }
  }, [repo])

  if (error !== null) {
    return (
      <p role="alert" className="mt-6 text-sm text-red-ink">
        Could not load the configuration of {repo}: {error}
      </p>
    )
  }
  if (view === null) return <p className="mt-6 text-fg-faint">loading configuration...</p>
  return (
    <div className="mt-6 space-y-4">
      {GROUPS.map((group) => (
        <GroupCard key={group} repo={repo} group={group} view={view} onSaved={setView} />
      ))}
      <div className={card}>
        <h2 className="mb-1 text-sm text-fg-muted">Server</h2>
        <p className="text-sm text-fg-faint">
          Listening on {view.server.host}:{view.server.port}. Set server.host and server.port in the
          user config and restart amagi serve: a change from here could lock the dashboard out.
        </p>
      </div>
    </div>
  )
}

function GroupCard({
  repo,
  group,
  view,
  onSaved,
}: {
  repo: string
  group: Group
  view: ConfigView
  onSaved: (view: ConfigView) => void
}) {
  const paths = (Object.keys(FIELDS) as EditableSettingPath[]).filter(
    (path) => FIELDS[path].group === group,
  )
  const [draft, setDraft] = useState<Partial<Values>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const changed = Object.keys(draft).length > 0
  const value = (path: EditableSettingPath) => (path in draft ? draft[path] : view.values[path])
  const set = (path: EditableSettingPath, next: unknown) => {
    setSaved(false)
    setDraft((current) => {
      const { [path]: _, ...rest } = current
      return JSON.stringify(next) === JSON.stringify(view.values[path])
        ? rest
        : { ...rest, [path]: next }
    })
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${encodeURIComponent(repo)}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: draft }),
      })
      const body = (await res.json().catch(() => null)) as (ConfigView & { error?: string }) | null
      if (!res.ok || body === null) {
        setError(body?.error ?? `HTTP ${res.status}`)
        return
      }
      setDraft({})
      setSaved(true)
      onSaved(body)
    } catch {
      setError('could not reach the amagi server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-3 text-sm text-fg-muted">{group}</h2>
      <div className="space-y-3">
        {paths.map((path) => {
          const rule = RULES.get(path)
          return (
            <div key={path}>
              <FieldControl
                path={path}
                spec={FIELDS[path]}
                value={value(path)}
                personas={view.personas}
                onChange={(next) => set(path, next)}
              />
              {(FIELDS[path].help !== undefined || rule?.idleOnly || rule?.restart) && (
                <p className="mt-1 text-xs text-fg-faint">
                  {[
                    FIELDS[path].help,
                    rule?.idleOnly && 'Refused while tasks run.',
                    rule?.restart && 'Applies after amagi serve restarts.',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </p>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!changed || busy}
          onClick={() => void save()}
          className={secondary}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {changed && (
          <button type="button" onClick={() => setDraft({})} className={secondary}>
            Discard
          </button>
        )}
        {saved && <span className="text-sm text-emerald-ink">saved</span>}
        {error !== null && (
          <span role="alert" className="text-sm text-red-ink">
            {error}
          </span>
        )}
      </div>
    </div>
  )
}

/** Empty number and text inputs send null, which resets the key to its default. */
function FieldControl({
  path,
  spec,
  value,
  personas,
  onChange,
}: {
  path: string
  spec: Field
  value: unknown
  personas: string[]
  onChange: (value: unknown) => void
}) {
  const id = `config-${path.replaceAll('.', '-')}`
  switch (spec.kind) {
    case 'bool':
      return (
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          {spec.label}
        </label>
      )
    case 'int':
    case 'number':
      return (
        <>
          <label className={field} htmlFor={id}>
            {spec.label}
          </label>
          <input
            id={id}
            type="number"
            step={spec.kind === 'int' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            onChange={(event) =>
              onChange(event.target.value === '' ? null : Number(event.target.value))
            }
            className={input}
          />
        </>
      )
    case 'text':
    case 'optionalText':
      return (
        <>
          <label className={field} htmlFor={id}>
            {spec.label}
          </label>
          <input
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
            className={`${input} font-mono`}
          />
        </>
      )
    case 'select':
    case 'persona': {
      const options = spec.kind === 'select' ? spec.options : personas
      return (
        <>
          <label className={field} htmlFor={id}>
            {spec.label}
          </label>
          <select
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
            className={input}
          >
            {spec.kind === 'persona' && <option value="">none</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </>
      )
    }
    case 'list':
      return (
        <ListEditor
          label={spec.label}
          items={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
        />
      )
    case 'harness':
      return (
        <HarnessFields
          label={spec.label}
          harness={value as Harness | null}
          optional={spec.optional === true}
          onChange={onChange}
        />
      )
    case 'harnesses':
      return (
        <HarnessDefinitions
          label={spec.label}
          value={(value ?? {}) as Record<string, Harness>}
          onChange={onChange}
        />
      )
    case 'contextOverrides':
      return (
        <ContextOverrides
          value={(value ?? {}) as Record<string, { warnTokens?: number; maxTokens?: number }>}
          onChange={onChange}
        />
      )
  }
}

/** Optional string keys are dropped when blank, so the config falls back to the harness default. */
function withKey<T extends object>(harness: T, key: string, next: string): T {
  const { [key]: _, ...rest } = harness as Record<string, unknown>
  return (next.trim() === '' ? rest : { ...rest, [key]: next.trim() }) as T
}

function HarnessFields({
  label,
  harness,
  optional,
  onChange,
}: {
  label: string
  harness: Harness | null
  optional: boolean
  onChange: (harness: Harness | null) => void
}) {
  if (harness === null) {
    return (
      <div className="text-sm text-fg">
        {label}: automatic{' '}
        <button type="button" className={secondary} onClick={() => onChange({ kind: 'claude' })}>
          Configure
        </button>
      </div>
    )
  }
  return (
    <fieldset className="space-y-2 rounded border border-line p-3">
      <legend className={field}>{label}</legend>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm text-fg-muted">
          Kind
          <select
            value={harness.kind}
            onChange={(event) => onChange({ ...harness, kind: event.target.value })}
            className={input}
          >
            {HARNESS_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-fg-muted">
          Permissions
          <select
            value={harness.permissions ?? 'workspace-write'}
            onChange={(event) => onChange({ ...harness, permissions: event.target.value })}
            className={input}
          >
            <option value="workspace-write">workspace-write</option>
            <option value="bypass">bypass</option>
          </select>
        </label>
        {(['model', 'effort', 'seat'] as const).map((key) => (
          <label key={key} className="text-sm text-fg-muted">
            {key}
            <input
              value={harness[key] ?? ''}
              placeholder="default"
              onChange={(event) => onChange(withKey(harness, key, event.target.value))}
              className={`${input} font-mono`}
            />
          </label>
        ))}
      </div>
      <ListEditor
        label="Command, one argument per row (empty: the kind's own binary)"
        items={harness.bin === undefined ? [] : [harness.bin].flat()}
        placeholder={harness.kind}
        onChange={(items) => {
          const { bin: _, ...rest } = harness
          if (items.length === 0) onChange(rest)
          else onChange({ ...rest, bin: items.length === 1 ? (items[0] as string) : items })
        }}
      />
      <ListEditor
        label="Allowed tools (empty: harness default)"
        items={harness.allowedTools ?? []}
        onChange={(items) => {
          const { allowedTools: _, ...rest } = harness
          onChange(items.length === 0 ? rest : { ...rest, allowedTools: items })
        }}
      />
      <ListEditor
        label="Extra arguments"
        items={harness.extraArgs ?? []}
        onChange={(items) => onChange({ ...harness, extraArgs: items })}
      />
      {optional && (
        <button type="button" className={secondary} onClick={() => onChange(null)}>
          Back to automatic
        </button>
      )}
    </fieldset>
  )
}

function HarnessDefinitions({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, Harness>
  onChange: (value: Record<string, Harness>) => void
}) {
  const [name, setName] = useState('')
  const taken = name.trim() === '' || name.trim() in value
  return (
    <div className="space-y-2">
      <span className={field}>{label}</span>
      {Object.entries(value).map(([key, harness]) => (
        <div key={key} className="space-y-1">
          <HarnessFields
            label={key}
            harness={harness}
            optional={false}
            onChange={(next) => onChange({ ...value, [key]: next ?? harness })}
          />
          <button
            type="button"
            className={secondary}
            onClick={() => {
              const { [key]: _, ...rest } = value
              onChange(rest)
            }}
          >
            Remove {key}
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          aria-label="New definition name"
          value={name}
          placeholder="name"
          onChange={(event) => setName(event.target.value)}
          className={`${input} font-mono`}
        />
        <button
          type="button"
          disabled={taken}
          className={secondary}
          onClick={() => {
            onChange({ ...value, [name.trim()]: { kind: 'claude' } })
            setName('')
          }}
        >
          Add definition
        </button>
      </div>
    </div>
  )
}

function ContextOverrides({
  value,
  onChange,
}: {
  value: Record<string, { warnTokens?: number; maxTokens?: number }>
  onChange: (value: Record<string, { warnTokens?: number; maxTokens?: number }>) => void
}) {
  const set = (kind: string, key: 'warnTokens' | 'maxTokens', raw: string) => {
    const { [key]: _, ...rest } = value[kind] ?? {}
    const entry = raw === '' ? rest : { ...rest, [key]: Number(raw) }
    const { [kind]: __, ...others } = value
    onChange(Object.keys(entry).length === 0 ? others : { ...others, [kind]: entry })
  }
  return (
    <fieldset>
      <legend className={field}>Per-harness overrides (blank: use the limits above)</legend>
      <div className="grid grid-cols-3 gap-2 text-sm text-fg-muted">
        {HARNESS_KINDS.map((kind) => (
          <div key={kind} className="space-y-1">
            <span>{kind}</span>
            {(['warnTokens', 'maxTokens'] as const).map((key) => (
              <input
                key={key}
                type="number"
                aria-label={`${kind} ${key}`}
                placeholder={key === 'warnTokens' ? 'warn' : 'restart'}
                value={value[kind]?.[key] ?? ''}
                onChange={(event) => set(kind, key, event.target.value)}
                className={input}
              />
            ))}
          </div>
        ))}
      </div>
    </fieldset>
  )
}
