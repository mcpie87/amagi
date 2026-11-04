import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { type RepoInfo, useDashboard } from '../store.tsx'
import { ConfigSettings } from './config-settings.tsx'
import { card, secondary, send, Toggle } from './settings-ui.tsx'

type Repo = { key: string; name: string; workers: boolean; watchers: boolean }
type GitIdentity = { mode: 'path' | 'inline'; value: string }
type ForgeKind = 'github' | 'gitlab' | 'forgejo'
type ForgeTokenSource = 'picked' | 'only' | 'environment' | null
type ForgeTokenState = { credential: string | null; source: ForgeTokenSource }
type ForgeSettings = {
  forgeKind: ForgeKind
  forgeRemote: string
  /** False while the remote is matched to the forge's host instead of named in the config. */
  forgeRemotePinned: boolean
  remotes: string[]
  forgeCredentials: Record<ForgeKind, ForgeTokenState>
}
export type ForgeCredential = { id: string; kind: ForgeKind; name: string; url: string | null }

/** `urlPlaceholder` is null for forges amagi only knows at their public address. */
const FORGES: {
  kind: ForgeKind
  label: string
  env: string
  urlPlaceholder: string | null
}[] = [
  { kind: 'github', label: 'GitHub', env: 'GH_TOKEN', urlPlaceholder: null },
  {
    kind: 'gitlab',
    label: 'GitLab',
    env: 'GITLAB_TOKEN',
    urlPlaceholder: 'https://gitlab.example.com',
  },
  {
    kind: 'forgejo',
    label: 'Forgejo',
    env: 'FORGEJO_TOKEN',
    urlPlaceholder: 'https://git.example.com',
  },
]

const urlInput =
  'min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg'

const ADD_TOKEN = '+add'

function TokenDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-line-strong bg-surface p-0 text-fg shadow-xl backdrop:bg-black/60"
    >
      <div className="border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold text-fg-strong">
          {title}
        </h2>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  )
}

const forgeSettings = (body: ForgeSettings): ForgeSettings => ({
  forgeKind: body.forgeKind,
  forgeRemote: body.forgeRemote,
  forgeRemotePinned: body.forgeRemotePinned,
  remotes: body.remotes,
  forgeCredentials: body.forgeCredentials,
})
const GIT_IDENTITY_TEMPLATE = '[user]\n\tname = Your Name\n\temail = you@example.com\n'

export function RepositoryParticipation({
  repo,
  onChanged,
}: {
  repo: Repo
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
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Repository participation</h2>
      <ul className="divide-y divide-line">
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
      </ul>
    </div>
  )
}

function RepositoryEpicClose({ repo }: { repo: Pick<Repo, 'key'> }) {
  const [epicCloseEnabled, setEpicCloseEnabled] = useState(false)
  const [epicCloseAvailable, setEpicCloseAvailable] = useState(false)
  const [epicCloseLoaded, setEpicCloseLoaded] = useState(false)
  const [epicCloseBusy, setEpicCloseBusy] = useState(false)
  const [epicCloseError, setEpicCloseError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setEpicCloseLoaded(false)
    setEpicCloseError(null)
    fetch(`${apiBase}/api/repos/${repo.key}/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as {
          epicCloseEnabled: boolean
          epicCloseAvailable: boolean
        }
      })
      .then((settings) => {
        if (!active) return
        setEpicCloseEnabled(settings.epicCloseEnabled)
        setEpicCloseAvailable(settings.epicCloseAvailable)
        setEpicCloseLoaded(true)
      })
      .catch((err: unknown) => {
        if (!active) return
        setEpicCloseError(err instanceof Error ? err.message : String(err))
        setEpicCloseLoaded(true)
      })
    return () => {
      active = false
    }
  }, [repo.key])

  const setEpicClose = async (enabled: boolean) => {
    setEpicCloseBusy(true)
    setEpicCloseError(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ epicCloseEnabled: enabled }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const settings = (await response.json()) as { epicCloseEnabled: boolean }
      setEpicCloseEnabled(settings.epicCloseEnabled)
    } catch (err) {
      setEpicCloseError(err instanceof Error ? err.message : String(err))
    } finally {
      setEpicCloseBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Automatic epic closure</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Automatically close eligible Beads epics when all their child tasks are complete.
      </p>
      {!epicCloseLoaded ? (
        <p className="text-sm text-fg-faint">Loading…</p>
      ) : (
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={epicCloseEnabled}
            disabled={epicCloseBusy || !epicCloseAvailable}
            onChange={(event) => void setEpicClose(event.currentTarget.checked)}
          />
          Enable automatic epic closure
          {!epicCloseAvailable && ' (available for Beads repositories)'}
        </label>
      )}
      {epicCloseError !== null && (
        <p role="alert" className="mt-2 text-sm text-red-ink">
          {epicCloseError}
        </p>
      )}
    </div>
  )
}

function RepositoryReview({ repo }: { repo: Pick<Repo, 'key'> }) {
  const [reviewEnabled, setReviewEnabled] = useState(false)
  const [reviewMaxRounds, setReviewMaxRounds] = useState(3)
  const [loaded, setLoaded] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewResult, setReviewResult] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch(`${apiBase}/api/repos/${repo.key}/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as { reviewEnabled: boolean; reviewMaxRounds: number }
      })
      .then((body) => {
        if (!active) return
        setReviewEnabled(body.reviewEnabled)
        setReviewMaxRounds(body.reviewMaxRounds)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (active) setReviewResult(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [repo.key])

  const save = async (patch: { reviewEnabled: boolean; reviewMaxRounds?: number }) => {
    setReviewBusy(true)
    setReviewResult(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = (await response.json()) as { reviewEnabled: boolean; reviewMaxRounds: number }
      setReviewEnabled(body.reviewEnabled)
      // The toggle saves only reviewEnabled; keep an unsaved rounds edit in the field.
      if (patch.reviewMaxRounds !== undefined) setReviewMaxRounds(body.reviewMaxRounds)
      setReviewResult('Saved')
    } catch (err) {
      setReviewResult(err instanceof Error ? err.message : String(err))
    } finally {
      setReviewBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Review</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Enable automated review for this repository. An enabled fleet worker with the Review role
        supplies the reviewer. Changes apply to new tasks.
      </p>
      {!loaded && reviewResult === null && <p className="text-sm text-fg-faint">Loading…</p>}
      {loaded && (
        <>
          <Toggle
            on={reviewEnabled}
            label="Review tasks"
            title="Enable automated review for this repository, disabled by default."
            disabled={reviewBusy}
            onClick={() => void save({ reviewEnabled: !reviewEnabled })}
          />
          <label htmlFor="review-max-rounds" className="mb-1 mt-3 block text-sm text-fg-muted">
            Maximum review rounds
          </label>
          <input
            id="review-max-rounds"
            type="number"
            min={1}
            step={1}
            value={reviewMaxRounds}
            disabled={reviewBusy}
            onChange={(event) => setReviewMaxRounds(Number(event.currentTarget.value))}
            className="w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
          />
          <button
            type="button"
            disabled={reviewBusy || !Number.isInteger(reviewMaxRounds) || reviewMaxRounds < 1}
            onClick={() => void save({ reviewEnabled, reviewMaxRounds })}
            className={`${secondary} mt-3`}
          >
            {reviewBusy ? 'Saving…' : 'Save'}
          </button>
        </>
      )}
      {reviewResult !== null && (
        <p role="status" className="mt-2 text-sm text-fg-faint">
          {reviewResult}
        </p>
      )}
    </div>
  )
}

type ProjectChecks = {
  before: string[]
  commands: string[]
  timeoutSec: number
  configured: boolean
}
type CommandRow = { id: string; command: string }
type CheckDraft = Omit<ProjectChecks, 'before' | 'commands'> & {
  before: CommandRow[]
  commands: CommandRow[]
}
const commandRows = (commands: string[]): CommandRow[] =>
  commands.map((command) => ({ id: crypto.randomUUID(), command }))
const checkDraft = (checks: ProjectChecks): CheckDraft => ({
  ...checks,
  before: commandRows(checks.before),
  commands: commandRows(checks.commands),
})

function CheckCommandList({
  title,
  help,
  rows,
  onChange,
}: {
  title: string
  help: string
  rows: CommandRow[]
  onChange: (rows: CommandRow[]) => void
}) {
  const move = (index: number, offset: number) => {
    const next = [...rows]
    const current = next[index]
    const other = next[index + offset]
    if (current === undefined || other === undefined) return
    next[index] = other
    next[index + offset] = current
    onChange(next)
  }
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-fg-strong text-sm">{title}</legend>
      <p className="text-xs text-fg-faint">{help}</p>
      {rows.length === 0 && <p className="text-sm text-fg-dim">No commands.</p>}
      {rows.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2">
          <label className="min-w-48 flex-1">
            <span className="sr-only">
              {title} command {index + 1}
            </span>
            <input
              required
              value={row.command}
              onChange={(event) =>
                onChange(
                  rows.map((value, i) =>
                    i === index ? { ...value, command: event.currentTarget.value } : value,
                  ),
                )
              }
              className="w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            className={secondary}
            aria-label={`Move ${title.toLowerCase()} command ${index + 1} up`}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={secondary}
            aria-label={`Move ${title.toLowerCase()} command ${index + 1} down`}
            disabled={index === rows.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={secondary}
            aria-label={`Remove ${title.toLowerCase()} command ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className={secondary}
        onClick={() => onChange([...rows, { id: crypto.randomUUID(), command: '' }])}
      >
        Add command
      </button>
    </fieldset>
  )
}

export function RepositoryChecks({
  repo,
  onChanged,
}: {
  repo: Pick<Repo, 'key'>
  onChanged: () => void
}) {
  const [checks, setChecks] = useState<CheckDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    let active = true
    fetch(`${apiBase}/api/repos/${repo.key}/checks`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as ProjectChecks
      })
      .then((body) => {
        if (active) setChecks(checkDraft(body))
      })
      .catch((err: unknown) => {
        if (active) setError(String(err))
      })
    return () => {
      active = false
    }
  }, [repo.key])
  const edit = (patch: Partial<CheckDraft>) => {
    setChecks((current) => (current === null ? null : { ...current, ...patch }))
    setSaved(false)
  }
  const save = async () => {
    if (checks === null) return
    setBusy(true)
    setSaved(false)
    setError(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/checks`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          before: checks.before.map(({ command }) => command),
          commands: checks.commands.map(({ command }) => command),
          timeoutSec: checks.timeoutSec,
        }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      setChecks(checkDraft((await response.json()) as ProjectChecks))
      setSaved(true)
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={card}>
      <h3 className="mb-1 font-medium text-fg-strong">Project checks</h3>
      <p className="mb-3 text-sm text-fg-faint">
        Your commands, in your order, run from the worktree root. Either list may be empty. Amagi
        supplies no commands.
      </p>
      {checks === null && error === null && <p>Loading…</p>}
      {checks !== null && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <legend className="sr-only">Project checks</legend>
            {!checks.configured && (
              <p className="text-sm text-amber-ink">
                Save the checks to finish setup; leave both lists empty to run no checks.
              </p>
            )}
            <CheckCommandList
              title="Before checks"
              help="Run on the untouched worktree before agent work. A failure parks the task."
              rows={checks.before}
              onChange={(before) => edit({ before })}
            />
            <CheckCommandList
              title="After checks"
              help="Run after agent work and each fix. A failure starts a fix round; passing gates the commit."
              rows={checks.commands}
              onChange={(commands) => edit({ commands })}
            />
            <label className="block text-sm">
              Timeout per command, seconds
              <input
                type="number"
                min={1}
                max={86400}
                required
                value={checks.timeoutSec}
                onChange={(event) => edit({ timeoutSec: event.currentTarget.valueAsNumber })}
                className="ml-3 w-28 rounded border border-line-strong bg-app px-3 py-2"
              />
            </label>
            <p className="text-xs text-fg-faint">
              Saved in this repository's .amagi/config.toml. A failing check stops the sequence.
            </p>
            <button
              type="submit"
              className={secondary}
              disabled={[...checks.before, ...checks.commands].some(
                ({ command }) => command.trim() === '',
              )}
            >
              {busy ? 'Saving…' : 'Save checks'}
            </button>
          </fieldset>
        </form>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-ink">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="mt-2 text-sm text-emerald-ink">
          Saved
        </p>
      )}
    </div>
  )
}

export function RepositoryGitIdentity({ repo }: { repo: Pick<Repo, 'key'> }) {
  const [mode, setMode] = useState<GitIdentity['mode']>('path')
  const [path, setPath] = useState('')
  const [inline, setInline] = useState(GIT_IDENTITY_TEMPLATE)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setLoaded(false)
    setError(null)
    setSaved(false)
    setPath('')
    setInline(GIT_IDENTITY_TEMPLATE)
    fetch(`${apiBase}/api/repos/${repo.key}/git-identity`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as { gitIdentity: GitIdentity | null }
      })
      .then(({ gitIdentity }) => {
        if (!active) return
        const nextMode = gitIdentity?.mode ?? 'path'
        setMode(nextMode)
        if (nextMode === 'path') setPath(gitIdentity?.value ?? '')
        else setInline(gitIdentity?.value ?? '')
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [repo.key])

  const saveIdentity = async (identity: GitIdentity | null) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/git-identity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(identity),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = (await response.json()) as { gitIdentity: GitIdentity | null }
      setMode(body.gitIdentity?.mode ?? 'path')
      if (body.gitIdentity === null) {
        setPath('')
        setInline(GIT_IDENTITY_TEMPLATE)
      } else if (body.gitIdentity.mode === 'path') {
        setPath(body.gitIdentity.value)
      } else {
        setInline(body.gitIdentity.value)
      }
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Git identity for amagi commits</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Applies only to amagi-created worktrees. Leave unset to use the repository persona or
        ambient Git identity.
      </p>
      {!loaded ? (
        <p className="text-sm text-fg-faint">Loading…</p>
      ) : (
        <>
          <fieldset disabled={busy}>
            <legend className="sr-only">Git identity source</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`git-identity-${repo.key}`}
                  value="path"
                  checked={mode === 'path'}
                  onChange={() => setMode('path')}
                />
                Gitconfig file
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`git-identity-${repo.key}`}
                  value="inline"
                  checked={mode === 'inline'}
                  onChange={() => setMode('inline')}
                />
                Inline text
              </label>
            </div>
          </fieldset>
          {mode === 'path' ? (
            <label className="mt-3 block text-sm text-fg-muted">
              Path to gitconfig
              <input
                type="text"
                value={path}
                onChange={(event) => setPath(event.currentTarget.value)}
                placeholder="~/.config/git/personas/work.gitconfig"
                className="mt-1 w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
              />
            </label>
          ) : (
            <label className="mt-3 block text-sm text-fg-muted">
              Gitconfig text
              <textarea
                value={inline}
                onChange={(event) => setInline(event.currentTarget.value)}
                placeholder={GIT_IDENTITY_TEMPLATE}
                rows={7}
                className="mt-1 w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
              />
            </label>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || (mode === 'path' && path.trim() === '')}
              onClick={() => void saveIdentity({ mode, value: mode === 'path' ? path : inline })}
              className={secondary}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void saveIdentity(null)}
              className={secondary}
            >
              Clear identity
            </button>
            {saved && <span className="text-sm text-fg-faint">Saved</span>}
          </div>
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-red-ink">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** Shared forge credentials; `reload` refetches after any card changes them. */
export function useForgeCredentials(): { credentials: ForgeCredential[]; reload: () => void } {
  const [credentials, setCredentials] = useState<ForgeCredential[]>([])
  const reload = useCallback(() => {
    fetch(`${apiBase}/api/forge-credentials`)
      .then((response) =>
        response.ok ? (response.json() as Promise<{ credentials: ForgeCredential[] }>) : null,
      )
      .then((body) => {
        if (body !== null) setCredentials(body.credentials)
      })
      .catch(() => {})
  }, [])
  useEffect(reload, [reload])
  return { credentials, reload }
}

async function createCredential(
  kind: ForgeKind,
  name: string,
  token: string,
  url: string | null,
): Promise<ForgeCredential> {
  const response = await fetch(`${apiBase}/api/forge-credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, token, url }),
  })
  if (!response.ok) throw new Error(await responseError(response))
  return (await response.json()) as ForgeCredential
}

function NewTokenForm({
  kind,
  allowForgeSelection = false,
  onCreated,
  onCancel,
}: {
  kind: ForgeKind
  allowForgeSelection?: boolean
  onCreated: (credential: ForgeCredential) => void
  onCancel?: () => void
}) {
  const [selectedKind, setSelectedKind] = useState(kind)
  const activeKind = allowForgeSelection ? selectedKind : kind
  const forge = FORGES.find((f) => f.kind === activeKind)
  const label = forge?.label ?? kind
  const urlPlaceholder = forge?.urlPlaceholder ?? null
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [url, setUrl] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [gitlabSetup, setGitlabSetup] = useState<{
    personal: string
    project: string | null
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await createCredential(activeKind, name.trim(), token.trim(), url.trim() || null))
      setName('')
      setToken('')
      setUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      aria-label={`New ${label} token`}
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy && name.trim() !== '' && token.trim() !== '') void submit()
      }}
      className="space-y-3"
    >
      {allowForgeSelection && (
        <select
          aria-label="Forge"
          disabled={busy}
          value={selectedKind}
          onChange={(event) => {
            setSelectedKind(event.currentTarget.value as ForgeKind)
            setUrl('')
            setGitlabSetup(null)
          }}
          className="w-full rounded border border-line-strong bg-app px-3 py-2 text-sm text-fg"
        >
          {FORGES.map(({ kind: forgeKind, label: forgeLabel }) => (
            <option key={forgeKind} value={forgeKind}>
              {forgeLabel}
            </option>
          ))}
        </select>
      )}
      {urlPlaceholder !== null && (
        <input
          type="url"
          aria-label={`${label} server URL`}
          disabled={busy}
          value={url}
          onChange={(event) => {
            setUrl(event.currentTarget.value)
            setGitlabSetup(null)
          }}
          placeholder={`${urlPlaceholder} (empty: from origin)`}
          className={urlInput}
        />
      )}
      {activeKind === 'gitlab' && (
        <div className="space-y-2 text-sm text-fg-muted">
          <p>
            Enter the GitLab server URL above and, for a project token, its group and project path.
          </p>
          <input
            type="text"
            aria-label="GitLab project path"
            value={projectPath}
            onChange={(event) => {
              setProjectPath(event.currentTarget.value)
              setGitlabSetup(null)
            }}
            placeholder="group/project (optional)"
            className="w-full rounded border border-line-strong bg-app px-3 py-2 text-sm text-fg"
          />
          <button
            type="button"
            className={secondary}
            onClick={() => {
              try {
                const server = new URL(url.trim())
                if (!['http:', 'https:'].includes(server.protocol) || server.search || server.hash)
                  throw new Error()
                const base = server.href.replace(/\/+$/, '')
                const path = projectPath.trim().replace(/^\/+|\/+$/g, '')
                if (
                  path &&
                  (path.split('/').length < 2 ||
                    path.split('/').some((part) => !part || part === '.' || part === '..'))
                )
                  throw new Error()
                setGitlabSetup({
                  personal: `${base}/-/user_settings/personal_access_tokens`,
                  project: path
                    ? `${base}/${path.split('/').map(encodeURIComponent).join('/')}/-/settings/access_tokens`
                    : null,
                })
                setError(null)
              } catch {
                setError('Enter a valid GitLab server URL and project path (group/project).')
              }
            }}
          >
            Set setup URL
          </button>
          {gitlabSetup !== null && (
            <p>
              <a
                href={gitlabSetup.personal}
                target="_blank"
                rel="noreferrer"
                className="text-sky-ink hover:underline"
              >
                Create a personal token
              </a>
              {gitlabSetup.project !== null && (
                <>
                  {' '}
                  {' · '}
                  <a
                    href={gitlabSetup.project}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-ink hover:underline"
                  >
                    Create a project token
                  </a>
                </>
              )}
            </p>
          )}
          <p>
            For a personal token, select Fine-grained token and limit it to the project. For a
            project token, select the Developer role and the <code>api</code> and{' '}
            <code>write_repository</code> scopes. See the{' '}
            <Link
              to="/manual"
              search={{ page: 'forge-tokens' }}
              hash="gitlab-project-access-token"
              className="text-sky-ink hover:underline"
            >
              token setup guide
            </Link>{' '}
            for the required fine-grained permissions and other details, then paste the token below.
          </p>
        </div>
      )}
      <input
        type="text"
        aria-label={`${label} token name`}
        disabled={busy}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="Name"
        className="w-full rounded border border-line-strong bg-app px-3 py-2 text-sm text-fg"
      />
      <div className="flex gap-2">
        <input
          type={showToken ? 'text' : 'password'}
          autoComplete="new-password"
          aria-label={`${label} token`}
          disabled={busy}
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          placeholder="Paste token"
          className="min-w-0 flex-1 rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
        />
        <button
          type="button"
          disabled={busy}
          aria-pressed={showToken}
          onClick={() => setShowToken((visible) => !visible)}
          className={secondary}
        >
          {showToken ? 'Hide token' : 'Show token'}
        </button>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel !== undefined && (
          <button type="button" disabled={busy} onClick={onCancel} className={secondary}>
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={busy || name.trim() === '' || token.trim() === ''}
          className={secondary}
        >
          {busy ? 'Saving…' : 'Save token'}
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-ink">
          {error}
        </p>
      )}
    </form>
  )
}

function CredentialRow({
  credential,
  onChanged,
}: {
  credential: ForgeCredential
  onChanged: () => void
}) {
  const forge = FORGES.find((item) => item.kind === credential.kind)
  const urlPlaceholder = FORGES.find((f) => f.kind === credential.kind)?.urlPlaceholder ?? null
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [url, setUrl] = useState(credential.url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => setUrl(credential.url ?? ''), [credential.url])

  const run = async (
    method: 'PATCH' | 'DELETE',
    body?: { token: string } | { url: string | null },
  ): Promise<boolean> => {
    setBusy(true)
    setError(null)
    const err = await send(method, `/api/forge-credentials/${credential.id}`, body)
    setBusy(false)
    if (err !== null) {
      setError(err)
      return false
    }
    setToken('')
    onChanged()
    return true
  }

  const remove = () => {
    if (window.confirm(`Delete token ${credential.name}?`)) {
      void run('DELETE').then((deleted) => deleted && setEditing(false))
    }
  }

  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded bg-raised px-2 py-1 text-xs text-fg-muted">
          {forge?.label ?? credential.kind}
        </span>
        <span className="min-w-32 flex-1 truncate text-sm text-fg-strong">{credential.name}</span>
        <span className="text-sm text-fg-faint">
          {credential.kind === 'github' ? 'github.com' : (credential.url ?? 'From origin')}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowToken(false)
            setEditing(true)
          }}
          className={secondary}
          aria-haspopup="dialog"
        >
          Edit <span className="sr-only">{credential.name}</span>
        </button>
      </div>
      {editing && (
        <TokenDialog
          title={`Edit ${credential.name}`}
          onClose={() => {
            setEditing(false)
            setShowToken(false)
          }}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type={showToken ? 'text' : 'password'}
                autoComplete="new-password"
                aria-label={`New token for ${credential.name}`}
                disabled={busy}
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                placeholder="Replace token"
                className="min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg"
              />
              <button
                type="button"
                disabled={busy}
                aria-pressed={showToken}
                onClick={() => setShowToken((visible) => !visible)}
                className={secondary}
              >
                {showToken ? 'Hide token' : 'Show token'}
              </button>
              <button
                type="button"
                disabled={busy || token.trim() === ''}
                onClick={() =>
                  void run('PATCH', { token: token.trim() }).then(
                    (saved) => saved && setEditing(false),
                  )
                }
                className={secondary}
              >
                Replace token
              </button>
            </div>
            {urlPlaceholder !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="url"
                  aria-label={`Server URL for ${credential.name}`}
                  disabled={busy}
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder={`${urlPlaceholder} (empty: from origin)`}
                  className={urlInput}
                />
                <button
                  type="button"
                  disabled={busy || url.trim() === (credential.url ?? '')}
                  onClick={() =>
                    void run('PATCH', { url: url.trim() || null }).then(
                      (saved) => saved && setEditing(false),
                    )
                  }
                  className={secondary}
                >
                  Save URL
                </button>
              </div>
            )}
            <div className="flex justify-between">
              <button type="button" disabled={busy} onClick={remove} className={secondary}>
                Delete
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className={secondary}
              >
                Close
              </button>
            </div>
            {error !== null && (
              <p role="alert" className="text-sm text-red-ink">
                {error}
              </p>
            )}
          </div>
        </TokenDialog>
      )}
    </li>
  )
}

export function ForgeCredentials({
  credentials,
  onChanged,
}: {
  credentials: ForgeCredential[]
  onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)

  return (
    <div className={`${card} mt-4`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm text-fg-muted">Forge tokens</h2>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={secondary}
          aria-haspopup="dialog"
        >
          Add token
        </button>
      </div>
      <p className="mb-3 mt-1 text-sm text-fg-faint">Shared across repositories.</p>
      <ul className="divide-y divide-line">
        {credentials.map((credential) => (
          <CredentialRow key={credential.id} credential={credential} onChanged={onChanged} />
        ))}
      </ul>
      {credentials.length === 0 && <p className="py-3 text-sm text-fg-faint">No saved tokens.</p>}
      {adding && (
        <TokenDialog title="Add forge token" onClose={() => setAdding(false)}>
          <NewTokenForm
            kind="github"
            allowForgeSelection
            onCancel={() => setAdding(false)}
            onCreated={() => {
              setAdding(false)
              onChanged()
            }}
          />
        </TokenDialog>
      )}
    </div>
  )
}

function tokenStatus(state: ForgeTokenState, credentials: ForgeCredential[], env: string): string {
  const name = credentials.find((credential) => credential.id === state.credential)?.name
  switch (state.source) {
    case 'picked':
      return `Using ${name}`
    case 'only':
      return `Using ${name} (only token)`
    case 'environment':
      return `Using ${env} from the environment`
    case null:
      return `No token (${env})`
  }
}

export function RepositoryForge({
  repo,
  credentials,
  onCredentialsChanged,
  onChanged,
}: {
  repo: Pick<Repo, 'key'>
  credentials: ForgeCredential[]
  onCredentialsChanged: () => void
  onChanged: () => void
}) {
  const [settings, setSettings] = useState<ForgeSettings | null>(null)
  const [adding, setAdding] = useState<ForgeKind | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: adding or deleting a shared token can change which one this repo resolves to.
  useEffect(() => {
    let active = true
    setError(null)
    fetch(`${apiBase}/api/repos/${repo.key}/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as ForgeSettings
      })
      .then((body) => {
        if (active) {
          setSettings(forgeSettings(body))
        }
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [repo.key, credentials])

  const save = async (patch: {
    forgeKind?: ForgeKind
    forgeRemote?: string | null
    forgeCredentials?: Partial<Record<ForgeKind, string | null>>
  }) => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = (await response.json()) as ForgeSettings
      setSettings(forgeSettings(body))
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Forge for pull requests</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Amagi opens pull requests on the selected forge only. Leave the remote on automatic to use
        the one pointing at that forge, and the token on automatic to use the only token for that
        forge, or the environment variable when there is none.
      </p>
      {settings === null ? (
        error === null ? (
          <p className="text-sm text-fg-faint">Loading…</p>
        ) : null
      ) : (
        <fieldset disabled={busy}>
          <legend className="sr-only">Pull request forge</legend>
          <label className="mb-2 flex flex-wrap items-center gap-3 text-sm text-fg-strong">
            <span className="w-32">Git remote</span>
            <select
              aria-label="Git remote"
              value={settings.forgeRemotePinned ? settings.forgeRemote : ''}
              onChange={(event) => {
                const value = event.currentTarget.value
                void save({ forgeRemote: value === '' ? null : value })
              }}
              className="rounded border border-line-strong bg-app px-2 py-1 text-sm text-fg"
            >
              <option value="">Automatic ({settings.forgeRemote})</option>
              {(settings.remotes.includes(settings.forgeRemote)
                ? settings.remotes
                : [settings.forgeRemote, ...settings.remotes]
              ).map((remote) => (
                <option key={remote} value={remote}>
                  {remote}
                </option>
              ))}
            </select>
            <span className="text-xs text-fg-faint">
              {settings.remotes.includes(settings.forgeRemote)
                ? 'Branches are pushed here and the forge CLI works on its repository.'
                : `No remote named ${settings.forgeRemote} in this repository.`}
            </span>
          </label>
          <ul className="divide-y divide-line">
            {FORGES.map(({ kind, label, env }) => {
              const state = settings.forgeCredentials[kind]
              const picked = state.source === 'picked' ? (state.credential ?? '') : ''
              return (
                <li key={kind} className="py-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex w-32 items-center gap-2 text-sm text-fg-strong">
                      <input
                        type="radio"
                        name={`forge-${repo.key}`}
                        value={kind}
                        checked={settings.forgeKind === kind}
                        onChange={() => void save({ forgeKind: kind })}
                      />
                      {label}
                    </label>
                    <select
                      aria-label={`${label} token`}
                      value={adding === kind ? ADD_TOKEN : picked}
                      onChange={(event) => {
                        const value = event.currentTarget.value
                        if (value === ADD_TOKEN) {
                          setAdding(kind)
                          return
                        }
                        setAdding(null)
                        void save({ forgeCredentials: { [kind]: value === '' ? null : value } })
                      }}
                      className="rounded border border-line-strong bg-app px-2 py-1 text-sm text-fg"
                    >
                      <option value="">Automatic</option>
                      {credentials
                        .filter((credential) => credential.kind === kind)
                        .map((credential) => (
                          <option key={credential.id} value={credential.id}>
                            {credential.name}
                          </option>
                        ))}
                      <option value={ADD_TOKEN}>Add token…</option>
                    </select>
                    <span className="text-xs text-fg-faint">
                      {tokenStatus(state, credentials, env)}
                    </span>
                  </div>
                  {adding === kind && (
                    <TokenDialog title={`Add ${label} token`} onClose={() => setAdding(null)}>
                      <NewTokenForm
                        kind={kind}
                        onCancel={() => setAdding(null)}
                        onCreated={(credential) => {
                          setAdding(null)
                          void save({ forgeCredentials: { [kind]: credential.id } }).then(
                            onCredentialsChanged,
                          )
                        }}
                      />
                    </TokenDialog>
                  )}
                </li>
              )
            })}
          </ul>
        </fieldset>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-ink">
          {error}
        </p>
      )}
    </div>
  )
}

const SETUP_SECTIONS = [
  ['connection', '1. Connection'],
  ['tracker', '2. Tracker'],
  ['checks', '3. Checks'],
  ['activation', '4. Activation'],
  ['automation', 'Automation'],
  ['advanced', 'Advanced'],
] as const

function readinessSection(name: string, detail = ''): string {
  if (name === 'checks' || (name === 'config' && detail.includes('[checks]'))) return 'checks'
  if (name.startsWith('tracker')) return 'tracker'
  if (name.startsWith('harness') || name.startsWith('worker') || name.startsWith('watcher'))
    return 'automation'
  return 'connection'
}

export function RepositorySettingsCard({
  repo,
  credentials,
  onChanged,
  onCredentialsChanged,
  children,
}: {
  repo: RepoInfo
  credentials: ForgeCredential[]
  onChanged: () => void
  onCredentialsChanged: () => void
  children?: ReactNode
}) {
  const [ready, setReady] = useState(repo.ready)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setReady(repo.ready), [repo.ready])
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/ready`)
      if (!response.ok) throw new Error(await responseError(response))
      setReady((await response.json()) as RepoInfo['ready'])
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }
  const changed = () => {
    void refresh()
  }
  const blockers = ready.filter((check) => !check.ok && !check.advisory)
  const sectionProblems = (section: string) =>
    ready.filter((check) => !check.ok && readinessSection(check.name, check.detail) === section)
  const activate = async () => {
    setBusy(true)
    setError(null)
    const error = await send('PATCH', `/api/repos/${repo.key}/participation`, {
      workers: true,
      watchers: true,
    })
    setBusy(false)
    await refresh()
    if (error !== null) setError(error)
  }
  const section = (id: string, title: string, content: ReactNode) => (
    <section id={`repository-${id}`} className="scroll-mt-4 space-y-4">
      <h2 className="text-lg font-semibold text-fg-strong">{title}</h2>
      {sectionProblems(id).map((check) => (
        <p
          key={check.name}
          role="status"
          className="rounded border border-amber-ink/30 bg-surface p-3 text-sm text-amber-ink"
        >
          {check.name}: {check.detail ?? 'Needs attention'}
        </p>
      ))}
      {content}
    </section>
  )
  return (
    <div className="mt-6 space-y-8">
      <div className={card}>
        <h2 className="text-lg font-semibold">{repo.name}</h2>
        <p className="mt-1 break-all font-mono text-sm text-fg-muted">{repo.path}</p>
        <p className="mt-3 text-sm">
          {blockers.length > 0 ? `${blockers.length} setup problem(s)` : 'Configuration ready'} ·{' '}
          {repo.workers || repo.watchers ? 'Participating' : 'Paused'}
        </p>
        <p className="mt-1 text-xs text-fg-faint">
          Readiness checks configuration and available tools. Project commands run in task
          worktrees.
        </p>
        <nav aria-label="Repository setup" className="mt-4 flex flex-wrap gap-3 text-sm">
          {SETUP_SECTIONS.map(([id, label]) => (
            <a key={id} href={`#repository-${id}`} className="underline">
              {label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className={`${secondary} mt-4`}
        >
          {busy ? 'Checking…' : 'Recheck readiness'}
        </button>
        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-red-ink">
            {error}
          </p>
        )}
      </div>
      {section(
        'connection',
        '1. Connect the repository',
        <>
          <RepositoryForge
            key={`forge:${repo.key}`}
            repo={repo}
            credentials={credentials}
            onChanged={changed}
            onCredentialsChanged={() => {
              onCredentialsChanged()
              changed()
            }}
          />
          <ConfigSettings repo={repo.key} groups={['Repository']} onChanged={changed} />
          <RepositoryGitIdentity repo={repo} />
        </>,
      )}
      {section(
        'tracker',
        '2. Choose the issue tracker',
        <ConfigSettings repo={repo.key} groups={['Tracker']} onChanged={changed} />,
      )}
      {section(
        'checks',
        '3. Define project checks',
        <RepositoryChecks key={`checks:${repo.key}`} repo={repo} onChanged={changed} />,
      )}
      {section(
        'activation',
        '4. Activate when ready',
        <div className={card}>
          <p className="mb-3 text-sm text-fg-muted">
            New repositories stay paused while you configure them. Activation allows workers to
            claim tasks and watchers to react to pull requests.
          </p>
          {blockers.length > 0 && (
            <ul className="mb-3 space-y-2 text-sm text-amber-ink">
              {blockers.map((check) => (
                <li key={check.name}>
                  <a
                    className="underline"
                    href={`#repository-${readinessSection(check.name, check.detail)}`}
                  >
                    {check.name}: {check.detail ?? 'Needs attention'}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {(!repo.workers || !repo.watchers) && (
            <button
              type="button"
              className={secondary}
              disabled={busy || blockers.length > 0}
              onClick={() => void activate()}
            >
              Activate repository
            </button>
          )}
          <RepositoryParticipation repo={repo} onChanged={changed} />
        </div>,
      )}
      {section(
        'automation',
        'Automation',
        <>
          <p className="text-sm text-fg-muted">
            Manage seats and watchers in{' '}
            <Link to="/settings" search={{ repo: repo.key, tab: 'workers' }} className="underline">
              Workers
            </Link>{' '}
            and execution settings in{' '}
            <Link to="/settings" search={{ repo: repo.key, tab: 'profiles' }} className="underline">
              Profiles
            </Link>
            .
          </p>
          <RepositoryEpicClose key={`epic-close:${repo.key}`} repo={repo} />
          <RepositoryReview key={`review:${repo.key}`} repo={repo} />
          {children}
          <ConfigSettings
            repo={repo.key}
            groups={['Review', 'Notifications']}
            onChanged={changed}
          />
        </>,
      )}
      {section(
        'advanced',
        'Advanced settings',
        <details>
          <summary className="cursor-pointer text-sm text-fg-muted">
            Run limits, watcher intervals, recovery, and context budgets
          </summary>
          <ConfigSettings
            repo={repo.key}
            groups={[
              'Checks and run limits',
              'Watcher intervals',
              'Stall and doom-loop guard',
              'Questions and retries',
              'Context budget',
            ]}
            onChanged={changed}
          />
        </details>,
      )}
    </div>
  )
}

export function AddRepository({
  open = false,
  onAdded,
}: {
  open?: boolean
  onAdded: (repo: string) => void
}) {
  const { addRepo } = useDashboard()
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <details open={open} className={`${card} mt-6`}>
      <summary className="cursor-pointer font-medium text-fg-strong">Add repository</summary>
      <p className="my-3 text-sm text-fg-muted">
        Choose an existing checkout on the Amagi server. You will configure its connection, tracker,
        and checks before activation.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy || path.trim() === '') return
          setBusy(true)
          setError(null)
          void addRepo(path.trim())
            .then((result) => {
              if ('error' in result) setError(result.error)
              else {
                setPath('')
                onAdded(result.key)
              }
            })
            .catch(() => setError('Could not reach the Amagi server'))
            .finally(() => setBusy(false))
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="min-w-48 flex-1 text-sm">
          Checkout path
          <input
            required
            value={path}
            onChange={(event) => setPath(event.currentTarget.value)}
            placeholder="/path/to/repository"
            className="mt-1 w-full rounded border border-line-strong bg-app px-3 py-2 font-mono"
          />
        </label>
        <button type="submit" className={secondary} disabled={busy || path.trim() === ''}>
          {busy ? 'Opening…' : 'Continue setup'}
        </button>
      </form>
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-red-ink">
          {error}
        </p>
      )}
    </details>
  )
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? `Request failed (${response.status})`
  } catch {
    return `Request failed (${response.status})`
  }
}
