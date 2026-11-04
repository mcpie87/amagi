import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useRunner } from '../store.tsx'
import { ProcessCapSettings, SeatsSettings } from './seats-settings.tsx'
import { card, secondary, send, Toggle } from './settings-ui.tsx'

const HARNESS_KINDS = ['claude', 'codex', 'opencode', 'omp'] as const
type HarnessKind = (typeof HARNESS_KINDS)[number]
const WORKER_ROLES = ['implement', 'review'] as const
type WorkerRole = (typeof WORKER_ROLES)[number]

const HARNESS_LABEL: Record<HarnessKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
}

type Worker = {
  id: string
  name: string
  kind: HarnessKind
  profile?: string
  model?: string
  effort?: string
  seat?: string
  roles: WorkerRole[]
  count?: number
  seatCount?: number
  enabled: boolean
  difficulties?: string[]
  taskId: string | null
}

type AgentWatcher = {
  enabled: boolean
  kind?: HarnessKind
  model?: string
  effort?: string
  seat?: string
}

type Watchers = {
  mention: AgentWatcher
  prConflict: AgentWatcher
  stall: { enabled: boolean }
}

type AgentWatcherKind = 'mention' | 'prConflict'

const WATCHER_NAMES: Record<keyof Watchers, string> = {
  mention: 'Mention watcher',
  prConflict: 'PR conflict watcher',
  stall: 'Stall watcher',
}

const input = 'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
const label = 'mb-1 block text-sm text-fg-muted'

type HarnessValues = { kind: HarnessKind | ''; model: string; effort: string; seat: string }

/**
 * Harness, model, effort and seat inputs shared by the worker and watcher
 * forms. An empty kind is only offered when `inheritKind` names the fallback.
 */
function HarnessFields({
  values,
  onChange,
  inheritKind,
  seats,
}: {
  values: HarnessValues
  onChange: (next: HarnessValues) => void
  inheritKind?: string
  seats: string[]
}) {
  const { options } = useRunner()
  const kind = values.kind === '' ? undefined : values.kind
  const models = kind === undefined ? [] : (options?.models[kind] ?? [])
  const efforts = kind === undefined ? [] : (options?.efforts[kind] ?? [])
  const [custom, setCustom] = useState(values.model !== '' && !models.includes(values.model))
  const set = (patch: Partial<HarnessValues>) => onChange({ ...values, ...patch })

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="fleet-kind">
            Harness
          </label>
          <select
            id="fleet-kind"
            value={values.kind}
            onChange={(e) => {
              setCustom(false)
              set({ kind: e.target.value as HarnessKind | '', model: '', effort: '' })
            }}
            className={input}
          >
            {inheritKind !== undefined && <option value="">default ({inheritKind})</option>}
            {HARNESS_KINDS.map((k) => (
              <option key={k} value={k}>
                {HARNESS_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="fleet-seat">
            Seat
          </label>
          <select
            id="fleet-seat"
            value={values.seat}
            onChange={(e) => set({ seat: e.target.value })}
            className={input}
          >
            <option value="">default ({kind ?? inheritKind ?? 'harness kind'})</option>
            {values.seat !== '' && !seats.includes(values.seat) && (
              <option value={values.seat}>{values.seat} (unlisted)</option>
            )}
            {seats.map((seat) => (
              <option key={seat} value={seat}>
                {seat}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="fleet-model">
            Model
          </label>
          <select
            id="fleet-model"
            value={custom ? 'custom' : values.model}
            onChange={(e) => {
              const next = e.target.value
              setCustom(next === 'custom')
              set({ model: next === 'custom' ? '' : next })
            }}
            className={input}
          >
            <option value="">default (harness)</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="custom">(custom model)</option>
          </select>
          {custom && (
            <input
              value={values.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="model id"
              className={`${input} mt-1`}
            />
          )}
        </div>
        <div>
          <label className={label} htmlFor="fleet-effort">
            Effort
          </label>
          <select
            id="fleet-effort"
            value={values.effort}
            onChange={(e) => set({ effort: e.target.value })}
            className={input}
          >
            <option value="">default (harness)</option>
            {values.effort !== '' && !efforts.includes(values.effort) && (
              <option value={values.effort}>{values.effort}</option>
            )}
            {efforts.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-sm text-fg-faint">
        Agents on the same seat take turns. Leave it empty to share the harness's default seat.
      </p>
    </>
  )
}

/** Blank strings become null so the server clears the field instead of storing "". */
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

function Modal({
  title,
  error,
  busy,
  submitLabel,
  canSubmit,
  onSubmit,
  onClose,
  children,
}: {
  title: string
  error: string | null
  busy: boolean
  submitLabel: string
  canSubmit: boolean
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && canSubmit) onSubmit()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg border border-line-strong bg-surface p-4"
      >
        <h2 className="mb-3 text-lg font-semibold">{title}</h2>
        <div className="space-y-3">{children}</div>
        {error !== null && <p className="mt-3 text-sm text-red-ink">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondary}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !canSubmit}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-on-solid hover:bg-accent/90 disabled:opacity-50"
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

function defaultName(workers: Worker[], kind: HarnessKind): string {
  const taken = new Set(workers.map((w) => w.name))
  for (let n = workers.filter((w) => w.kind === kind).length + 1; ; n++) {
    const name = `${HARNESS_LABEL[kind]} ${n}`
    if (!taken.has(name)) return name
  }
}

type NamedProfile = { profile_name: string; harness: HarnessKind; model: string; effort: string }

function WorkerFormModal({
  repo,
  profiles,
  initial,
  workers,
  seats,
  levels,
  onClose,
  onSaved,
}: {
  repo: string
  profiles: NamedProfile[]
  initial: Worker | null
  workers: Worker[]
  seats: string[]
  levels: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? defaultName(workers, 'claude'))
  const [nameTouched, setNameTouched] = useState(initial !== null)
  const [count, setCount] = useState(String(initial?.count ?? 1))
  const [roles, setRoles] = useState<WorkerRole[]>(initial?.roles ?? ['implement'])
  const [difficulties, setDifficulties] = useState<string[]>(initial?.difficulties ?? levels)
  const [profileName, setProfileName] = useState(initial?.profile ?? '')
  const [seat, setSeat] = useState(initial?.seat ?? '')
  const selectedProfile = profiles.find((profile) => profile.profile_name === profileName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const workerCount = Number(count)
  const validCount = Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= 16

  const save = async () => {
    setBusy(true)
    setError(null)
    if (selectedProfile === undefined) return
    const id = initial?.id ?? `worker-${crypto.randomUUID()}`
    const fields = {
      id,
      name: name.trim(),
      profile: selectedProfile.profile_name,
      kind: selectedProfile.harness,
      model: selectedProfile.model,
      effort: selectedProfile.effort,
      ...(seat === '' ? {} : { seat }),
      count: workerCount,
      seatCount: Math.min(initial?.seatCount ?? 1, workerCount),
      enabled: initial?.enabled ?? false,
      roles,
      ...(levels.every((level) => difficulties.includes(level))
        ? {}
        : {
            difficulties: levels.filter((level) => difficulties.includes(level)),
          }),
    }
    const next =
      initial === null
        ? [...workers, fields]
        : workers.map((worker) => (worker.id === id ? fields : worker))
    const err = await send('PUT', `/api/repos/${encodeURIComponent(repo)}/workers`, {
      workers: next,
    })
    setBusy(false)
    if (err !== null) setError(err)
    else onSaved()
  }

  return (
    <Modal
      title={initial === null ? 'New worker' : `Edit ${initial.name}`}
      error={error}
      busy={busy}
      submitLabel={initial === null ? 'Create worker' : 'Save changes'}
      canSubmit={name.trim() !== '' && validCount && selectedProfile !== undefined}
      onSubmit={() => void save()}
      onClose={onClose}
    >
      <div>
        <label className={label} htmlFor="worker-name">
          Name
        </label>
        <input
          id="worker-name"
          value={name}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value)
          }}
          className={input}
        />
      </div>
      <div>
        <label className={label} htmlFor="worker-count">
          Worker count
        </label>
        <input
          id="worker-count"
          type="number"
          min={1}
          max={16}
          step={1}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          className={input}
        />
      </div>
      {!validCount && (
        <p className="text-sm text-red-ink">Worker count must be between 1 and 16.</p>
      )}
      <div>
        <label className={label} htmlFor="worker-profile">
          Profile
        </label>
        <select
          id="worker-profile"
          className={input}
          value={profileName}
          onChange={(event) => {
            const next = event.currentTarget.value
            setProfileName(next)
            const profile = profiles.find((entry) => entry.profile_name === next)
            if (!nameTouched && profile !== undefined)
              setName(defaultName(workers, profile.harness))
          }}
        >
          <option value="">Select a profile</option>
          {profiles.map((profile) => (
            <option key={profile.profile_name} value={profile.profile_name}>
              {profile.profile_name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={label} htmlFor="worker-seat">
          Seat
        </label>
        <select
          id="worker-seat"
          className={input}
          value={seat}
          onChange={(event) => setSeat(event.currentTarget.value)}
        >
          <option value="">Harness default</option>
          {seat !== '' && !seats.includes(seat) && <option value={seat}>{seat}</option>}
          {seats.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className={label}>Applicable roles</legend>
        <div className="flex flex-wrap gap-4">
          {WORKER_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(event) =>
                  setRoles((current) =>
                    event.target.checked
                      ? [...current, role]
                      : current.filter((assigned) => assigned !== role),
                  )
                }
              />
              {role === 'implement' ? 'Implement' : 'Review'}
            </label>
          ))}
        </div>
      </fieldset>
      {levels.length > 0 && (
        <fieldset>
          <legend className={label}>Task difficulty</legend>
          <div className="flex flex-wrap gap-4">
            {levels.map((level) => (
              <label key={level} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={difficulties.includes(level)}
                  onChange={(event) =>
                    setDifficulties((current) =>
                      event.target.checked
                        ? [...current, level]
                        : current.filter((taken) => taken !== level),
                    )
                  }
                />
                {level}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-fg-faint">
            Applies when difficulty gating is on; unclassified tasks go to any worker.
          </p>
        </fieldset>
      )}
      {initial?.taskId != null && (
        <p className="text-sm text-amber-ink">
          {initial.taskId} keeps its current settings; changes apply from the next run.
        </p>
      )}
    </Modal>
  )
}

function WatcherFormModal({
  kind,
  initial,
  seats,
  onClose,
  onSaved,
}: {
  kind: AgentWatcherKind
  initial: AgentWatcher
  seats: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [harness, setHarness] = useState<HarnessValues>({
    kind: initial.kind ?? '',
    model: initial.model ?? '',
    effort: initial.effort ?? '',
    seat: initial.seat ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    const err = await send('PATCH', `/api/watchers/${kind}`, {
      kind: harness.kind === '' ? null : harness.kind,
      model: orNull(harness.model),
      effort: orNull(harness.effort),
      seat: orNull(harness.seat),
    })
    setBusy(false)
    if (err !== null) setError(err)
    else onSaved()
  }

  return (
    <Modal
      title={`Edit ${WATCHER_NAMES[kind]}`}
      error={error}
      busy={busy}
      submitLabel="Save changes"
      canSubmit
      onSubmit={() => void save()}
      onClose={onClose}
    >
      <HarnessFields
        values={harness}
        onChange={setHarness}
        inheritKind="implement harness"
        seats={seats}
      />
    </Modal>
  )
}

function Profile({
  kind,
  model,
  effort,
  seat,
}: {
  kind: string
  model?: string | undefined
  effort?: string | undefined
  seat?: string | undefined
}) {
  return (
    <p className="text-sm text-fg-muted">
      {kind} · {model ?? 'default model'} · {effort ?? 'default effort'} · seat {seat ?? kind}
    </p>
  )
}

function WorkerCard({
  repo,
  workers,
  worker,
  onEdit,
  onChanged,
}: {
  repo: string
  workers: Worker[]
  worker: Worker
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (method: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    const next =
      method === 'DELETE'
        ? workers.filter((entry) => entry.id !== worker.id)
        : workers.map((entry) =>
            entry.id === worker.id ? { ...entry, ...(body as object) } : entry,
          )
    const err = await send('PUT', `/api/repos/${encodeURIComponent(repo)}/workers`, {
      workers: next,
    })
    setBusy(false)
    if (err !== null) setError(err)
    onChanged()
  }

  const remove = () => {
    if (window.confirm(`Delete worker ${worker.name}?`)) void act('DELETE')
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-fg-strong">
            {worker.name} <span className="text-xs text-fg-faint">{worker.id}</span>
          </h3>
          {worker.profile !== undefined && (
            <p className="text-sm text-fg-muted">Profile: {worker.profile}</p>
          )}
          <Profile
            kind={worker.kind}
            model={worker.model}
            effort={worker.effort}
            seat={worker.seat}
          />
          <p className="text-sm text-fg-faint">Worker count: {worker.count ?? 1}</p>
          {worker.difficulties !== undefined && (
            <p className="text-sm text-fg-faint">
              Difficulty: {worker.difficulties.length > 0 ? worker.difficulties.join(', ') : 'none'}
            </p>
          )}
          {worker.taskId !== null && (
            <p className="text-sm text-fg-faint">running {worker.taskId}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle
            on={worker.enabled}
            label="Enabled"
            title="Persisted across restarts. A disabled worker refuses every dispatch, manual included."
            disabled={busy}
            onClick={() => void act('PATCH', { enabled: !worker.enabled })}
          />
          <button type="button" onClick={onEdit} disabled={busy} className={secondary}>
            Edit
          </button>
          <button type="button" onClick={remove} disabled={busy} className={secondary}>
            Delete
          </button>
        </div>
      </div>
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

function WatcherCard({
  kind,
  watcher,
  onEdit,
  onChanged,
}: {
  kind: keyof Watchers
  watcher: AgentWatcher
  onEdit?: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = async () => {
    setBusy(true)
    setError(null)
    const err = await send('PATCH', `/api/watchers/${kind}`, { enabled: !watcher.enabled })
    setBusy(false)
    if (err !== null) setError(err)
    onChanged()
  }

  return (
    <div className={card}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-fg-strong">{WATCHER_NAMES[kind]}</h3>
          {onEdit === undefined ? (
            <p className="text-sm text-fg-muted">spawns no agent</p>
          ) : (
            <Profile
              kind={watcher.kind ?? 'implement harness'}
              model={watcher.model}
              effort={watcher.effort}
              seat={watcher.seat}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Toggle
            on={watcher.enabled}
            label="Enabled"
            title="Takes effect within a few seconds, without a restart."
            disabled={busy}
            onClick={() => void toggle()}
          />
          {onEdit !== undefined && (
            <button type="button" onClick={onEdit} disabled={busy} className={secondary}>
              Edit
            </button>
          )}
        </div>
      </div>
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
    </div>
  )
}

/** The global fleet editor: workers, seats and watchers. */
export function FleetWorkersSettings() {
  const [watchers, setWatchers] = useState<Watchers | null>(null)
  const [seatNames, setSeatNames] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editingWatcher, setEditingWatcher] = useState<AgentWatcherKind | null>(null)

  const refresh = useCallback(() => {
    fetch(`${apiBase}/api/watchers`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setWatchers((await response.json()) as Watchers)
        setLoadError(null)
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : 'could not reach the amagi server'),
      )
  }, [])

  const refreshSeats = useCallback(() => {
    fetch(`${apiBase}/api/seat-names`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { seats: { name: string; count: number }[] }
        setSeatNames(body.seats.map(({ name }) => name))
      })
      .catch((err: unknown) =>
        setLoadError(err instanceof Error ? err.message : 'could not reach the amagi server'),
      )
  }, [])

  useEffect(() => {
    refresh()
    refreshSeats()
    // A worker's on flag and running task change underneath the page.
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [refresh, refreshSeats])

  const saved = () => {
    setEditingWatcher(null)
    refresh()
  }

  return (
    <>
      {loadError !== null && <p className="text-sm text-red-ink">{loadError}</p>}
      <SeatsSettings onSaved={refreshSeats} />

      <ProcessCapSettings />

      {watchers !== null && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm text-fg-muted">Watchers</h2>
          <div className="space-y-2">
            <WatcherCard
              kind="mention"
              watcher={watchers.mention}
              onEdit={() => setEditingWatcher('mention')}
              onChanged={refresh}
            />
            <WatcherCard
              kind="prConflict"
              watcher={watchers.prConflict}
              onEdit={() => setEditingWatcher('prConflict')}
              onChanged={refresh}
            />
            <WatcherCard kind="stall" watcher={watchers.stall} onChanged={refresh} />
          </div>
        </div>
      )}

      {editingWatcher !== null && watchers !== null && (
        <WatcherFormModal
          kind={editingWatcher}
          initial={watchers[editingWatcher]}
          seats={seatNames}
          onClose={() => setEditingWatcher(null)}
          onSaved={saved}
        />
      )}
    </>
  )
}

export function RepositoryWorkersSettings({
  repo,
  onChanged,
}: {
  repo: string
  onChanged: () => void
}) {
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [profiles, setProfiles] = useState<NamedProfile[]>([])
  const [seats, setSeats] = useState<string[]>([])
  const [levels, setLevels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Worker | 'new' | null>(null)
  const refresh = useCallback(() => {
    Promise.all([
      fetch(`${apiBase}/api/repos/${encodeURIComponent(repo)}/workers`),
      fetch(`${apiBase}/api/seat-names`),
    ])
      .then(async ([response, seatResponse]) => {
        if (!response.ok || !seatResponse.ok) throw new Error('Could not load workers')
        const body = (await response.json()) as {
          workers: Worker[]
          profiles: NamedProfile[]
          difficultyLevels: string[]
        }
        const seatBody = (await seatResponse.json()) as { seats: { name: string }[] }
        setWorkers(body.workers)
        setProfiles(body.profiles)
        setLevels(body.difficultyLevels)
        setSeats(seatBody.seats.map(({ name }) => name))
        setError(null)
      })
      .catch((err: unknown) => setError(String(err)))
  }, [repo])
  useEffect(() => {
    refresh()
  }, [refresh])
  const changed = () => {
    setEditing(null)
    refresh()
    onChanged()
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Workers</h3>
        <button
          type="button"
          className={secondary}
          disabled={workers === null || profiles.length === 0}
          onClick={() => setEditing('new')}
        >
          Add worker
        </button>
      </div>
      {profiles.length === 0 && (
        <p className="text-sm text-fg-muted">Create a profile before adding a worker.</p>
      )}
      {error !== null && <p className="text-sm text-red-ink">{error}</p>}
      {workers?.length === 0 && <p className="text-sm text-fg-muted">No workers configured.</p>}
      {workers?.map((worker) => (
        <WorkerCard
          key={worker.id}
          repo={repo}
          workers={workers}
          worker={worker}
          onEdit={() => setEditing(worker)}
          onChanged={changed}
        />
      ))}
      {editing !== null && workers !== null && (
        <WorkerFormModal
          repo={repo}
          profiles={profiles}
          initial={editing === 'new' ? null : editing}
          workers={workers}
          seats={seats}
          levels={levels}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </div>
  )
}
