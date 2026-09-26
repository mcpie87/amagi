import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { useRunner } from '../store.tsx'

const HARNESS_KINDS = ['claude', 'codex', 'opencode'] as const
type HarnessKind = (typeof HARNESS_KINDS)[number]

const HARNESS_LABEL: Record<HarnessKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
}

type Worker = {
  id: string
  name: string
  kind: HarnessKind
  model?: string
  effort?: string
  seat?: string
  enabled: boolean
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

/** Sends a JSON request, resolving to the server's error message or null on success. */
async function send(method: string, path: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (res.ok) return null
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null
    return parsed?.error ?? `HTTP ${res.status}`
  } catch {
    return 'could not reach the amagi server'
  }
}

const input = 'w-full rounded border border-line-strong bg-sunken px-3 py-1 text-sm text-fg-strong'
const label = 'mb-1 block text-sm text-fg-muted'
const secondary =
  'rounded border border-line-strong bg-surface px-3 py-1 text-sm hover:bg-raised disabled:opacity-50'
const card = 'rounded-lg border border-line bg-surface p-4'

function Toggle({
  on,
  label: text,
  title,
  disabled,
  onClick,
}: {
  on: boolean
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded px-3 py-1 text-sm font-medium disabled:opacity-50 ${
        on
          ? 'bg-emerald-600 text-on-solid hover:bg-emerald-500'
          : 'border border-line-strong bg-surface text-fg-muted hover:bg-raised'
      }`}
    >
      {text}: {on ? 'on' : 'off'}
    </button>
  )
}

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
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
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

function WorkerFormModal({
  initial,
  workers,
  seats,
  onClose,
  onSaved,
}: {
  initial: Worker | null
  workers: Worker[]
  seats: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? defaultName(workers, 'claude'))
  const [nameTouched, setNameTouched] = useState(initial !== null)
  const [harness, setHarness] = useState<HarnessValues>({
    kind: initial?.kind ?? 'claude',
    model: initial?.model ?? '',
    effort: initial?.effort ?? '',
    seat: initial?.seat ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeHarness = (next: HarnessValues) => {
    if (!nameTouched && next.kind !== '' && next.kind !== harness.kind) {
      setName(defaultName(workers, next.kind))
    }
    setHarness(next)
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    const fields = {
      name: name.trim(),
      kind: harness.kind,
      model: orNull(harness.model),
      effort: orNull(harness.effort),
      seat: orNull(harness.seat),
    }
    const err =
      initial === null
        ? await send(
            'POST',
            '/api/workers',
            Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null)),
          )
        : await send('PATCH', `/api/workers/${initial.id}`, fields)
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
      canSubmit={name.trim() !== ''}
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
      <HarnessFields values={harness} onChange={changeHarness} seats={seats} />
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
  worker,
  onEdit,
  onChanged,
}: {
  worker: Worker
  onEdit: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = async (method: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    const err = await send(method, `/api/workers/${worker.id}`, body)
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
          <Profile
            kind={worker.kind}
            model={worker.model}
            effort={worker.effort}
            seat={worker.seat}
          />
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

function ParticipationRow({
  repo,
  onChanged,
}: {
  repo: { key: string; name: string; workers: boolean; watchers: boolean }
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = async (patch: { workers?: boolean; watchers?: boolean }) => {
    setBusy(true)
    setError(null)
    const err = await send('PATCH', `/api/repos/${repo.key}/participation`, patch)
    setBusy(false)
    if (err !== null) setError(err)
    onChanged()
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-sm text-fg-strong">{repo.name}</span>
      <div className="flex flex-wrap items-center gap-2">
        {error !== null && <span className="text-sm text-red-ink">{error}</span>}
        <Toggle
          on={repo.workers}
          label="Workers"
          title="Whether the auto-queue claims ready tasks from this repository."
          disabled={busy}
          onClick={() => void set({ workers: !repo.workers })}
        />
        <Toggle
          on={repo.watchers}
          label="Watchers"
          title="Whether pollers and watchers run against this repository."
          disabled={busy}
          onClick={() => void set({ watchers: !repo.watchers })}
        />
      </div>
    </li>
  )
}

type SeatDraft = { original: string | null; name: string }

function SeatsEditor({
  entries,
  setEntries,
  onSaved,
}: {
  entries: SeatDraft[] | null
  setEntries: (entries: SeatDraft[]) => void
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names = entries?.map(({ name }) => name.trim()).filter(Boolean) ?? []
  const valid =
    entries?.every(({ name }) => name.trim() !== '') && new Set(names).size === names.length

  const save = async () => {
    if (entries === null || !valid) return
    setBusy(true)
    setError(null)
    const seats = entries.map(({ name }) => name.trim())
    const renames = entries.flatMap(({ original, name }) =>
      original !== null && original !== name.trim() ? [{ from: original, to: name.trim() }] : [],
    )
    const err = await send('PUT', '/api/seat-names', { seats, renames })
    setBusy(false)
    if (err !== null) setError(err)
    else onSaved()
  }

  return (
    <div className={`mt-6 ${card}`}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm text-fg-muted">Seats</h2>
        <button
          type="button"
          onClick={() => setEntries([...(entries ?? []), { original: null, name: '' }])}
          disabled={entries === null || busy}
          className={secondary}
        >
          Add seat
        </button>
      </div>
      <p className="mb-3 text-sm text-fg-faint">
        Rename a seat to update every worker, watcher, and harness that uses it. Removing a seat
        resets its references to the default seat.
      </p>
      {entries === null ? (
        <p className="text-sm text-fg-faint">Loading seats...</p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, index) => (
            <div key={entry.original ?? `new-${index}`} className="flex gap-2">
              <input
                aria-label={`Seat ${index + 1}`}
                value={entry.name}
                onChange={(event) =>
                  setEntries(
                    entries.map((seat, i) =>
                      i === index ? { ...seat, name: event.target.value } : seat,
                    ),
                  )
                }
                className={input}
              />
              <button
                type="button"
                onClick={() => setEntries(entries.filter((_, i) => i !== index))}
                disabled={busy}
                className={secondary}
              >
                Remove
              </button>
            </div>
          ))}
          {entries.length === 0 && <p className="text-sm text-fg-faint">No named seats.</p>}
        </div>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-ink">{error}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!valid || busy}
          className={secondary}
        >
          {busy ? 'Saving...' : 'Save seats'}
        </button>
        {entries !== null && !valid && (
          <span className="text-sm text-amber-ink">Seat names must be unique and non-empty.</span>
        )}
      </div>
    </div>
  )
}

/** The global fleet editor: workers, seats and watchers. */
export function FleetWorkersSettings() {
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [watchers, setWatchers] = useState<Watchers | null>(null)
  const [seatEntries, setSeatEntries] = useState<SeatDraft[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Worker | 'new' | null>(null)
  const [editingWatcher, setEditingWatcher] = useState<AgentWatcherKind | null>(null)

  const refresh = useCallback(() => {
    Promise.all([fetch(`${apiBase}/api/workers`), fetch(`${apiBase}/api/watchers`)])
      .then(async ([w, v]) => {
        if (!w.ok || !v.ok) throw new Error(`HTTP ${w.ok ? v.status : w.status}`)
        setWorkers(((await w.json()) as { workers: Worker[] }).workers)
        setWatchers((await v.json()) as Watchers)
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
        const body = (await res.json()) as { seats: string[] }
        setSeatEntries(body.seats.map((name) => ({ original: name, name })))
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
    setEditing(null)
    setEditingWatcher(null)
    refresh()
  }

  const seatsSaved = () => refreshSeats()
  const seatNames = seatEntries?.map(({ name }) => name.trim()).filter(Boolean) ?? []

  return (
    <>
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm text-fg-muted">Workers</h2>
          <button
            type="button"
            onClick={() => setEditing('new')}
            disabled={workers === null}
            className="rounded bg-sky-600 px-3 py-1 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50"
          >
            Add worker
          </button>
        </div>
        <p className="mb-3 text-sm text-fg-faint">
          Workers live in the global config and serve every repository. Capacity is one run per free
          seat among the enabled workers.
        </p>
        {loadError !== null && <p className="text-sm text-red-ink">{loadError}</p>}
        {workers?.length === 0 && <p className="text-sm text-fg-faint">no workers configured</p>}
        <div className="space-y-2">
          {workers?.map((worker) => (
            <WorkerCard
              key={worker.id}
              worker={worker}
              onEdit={() => setEditing(worker)}
              onChanged={refresh}
            />
          ))}
        </div>
      </div>

      <SeatsEditor entries={seatEntries} setEntries={setSeatEntries} onSaved={seatsSaved} />

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

      {editing !== null && workers !== null && (
        <WorkerFormModal
          initial={editing === 'new' ? null : editing}
          workers={workers}
          seats={seatNames}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
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

export function RepositoryParticipationCard({
  repo,
  onChanged,
}: {
  repo: { key: string; name: string; workers: boolean; watchers: boolean }
  onChanged: () => void
}) {
  return (
    <div className={`mt-6 ${card}`}>
      <h2 className="mb-1 text-sm text-fg-muted">Repositories</h2>
      <ul className="divide-y divide-line">
        <ParticipationRow repo={repo} onChanged={onChanged} />
      </ul>
    </div>
  )
}
