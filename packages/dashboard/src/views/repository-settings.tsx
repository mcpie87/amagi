import { useCallback, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
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
  cli: string
  env: string
  urlPlaceholder: string | null
}[] = [
  { kind: 'github', label: 'GitHub', cli: 'gh', env: 'GH_TOKEN', urlPlaceholder: null },
  {
    kind: 'gitlab',
    label: 'GitLab',
    cli: 'glab',
    env: 'GITLAB_TOKEN',
    urlPlaceholder: 'https://gitlab.example.com',
  },
  {
    kind: 'forgejo',
    label: 'Forgejo',
    cli: 'tea',
    env: 'FORGEJO_TOKEN',
    urlPlaceholder: 'https://git.example.com',
  },
]

const urlInput =
  'min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg'

const ADD_TOKEN = '+add'

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

  const save = async (enabled: boolean) => {
    setReviewBusy(true)
    setReviewResult(null)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewEnabled: enabled, reviewMaxRounds }),
      })
      if (!response.ok) throw new Error(await responseError(response))
      const body = (await response.json()) as { reviewEnabled: boolean; reviewMaxRounds: number }
      setReviewEnabled(body.reviewEnabled)
      setReviewMaxRounds(body.reviewMaxRounds)
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
            disabled={reviewBusy || !Number.isInteger(reviewMaxRounds) || reviewMaxRounds < 1}
            onClick={() => void save(!reviewEnabled)}
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
            onClick={() => void save(reviewEnabled)}
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

type CheckCommands = { format: string; lint: string; test: string }

function RepositoryChecks({ repo, onChanged }: { repo: Pick<Repo, 'key'>; onChanged: () => void }) {
  const [checks, setChecks] = useState<CheckCommands>({ format: '', lint: '', test: '' })
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    fetch(`${apiBase}/api/repos/${repo.key}/checks`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as Record<keyof CheckCommands, string | null>
      })
      .then((body) => {
        if (!active) return
        setChecks({ format: body.format ?? '', lint: body.lint ?? '', test: body.test ?? '' })
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [repo.key])

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(`${apiBase}/api/repos/${repo.key}/checks`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checks),
      })
      if (!response.ok) throw new Error(await responseError(response))
      setChecks((await response.json()) as CheckCommands)
      setSaved(true)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Project checks</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Required shell commands in this repository's .amagi/config.toml. Run in order: format, lint,
        test, then any extra check commands. Use true to explicitly skip a check.
      </p>
      {!loaded && error === null && <p className="text-sm text-fg-faint">Loading…</p>}
      {loaded && (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={busy} className="space-y-3">
            <legend className="sr-only">Project check commands</legend>
            {(['format', 'lint', 'test'] as const).map((name) => (
              <label key={name} className="block text-sm text-fg-muted">
                {name === 'format' ? 'Format' : name === 'lint' ? 'Lint' : 'Test'}
                <input
                  type="text"
                  required
                  value={checks[name]}
                  onChange={(event) => {
                    setChecks({ ...checks, [name]: event.currentTarget.value })
                    setSaved(false)
                  }}
                  className="mt-1 w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
                />
              </label>
            ))}
            <button
              type="submit"
              className={secondary}
              disabled={Object.values(checks).some((command) => command.trim() === '')}
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
        <p role="status" className="mt-2 text-sm text-fg-muted">
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
  onCreated,
  onCancel,
}: {
  kind: ForgeKind
  onCreated: (credential: ForgeCredential) => void
  onCancel?: () => void
}) {
  const forge = FORGES.find((f) => f.kind === kind)
  const label = forge?.label ?? kind
  const urlPlaceholder = forge?.urlPlaceholder ?? null
  const [name, setName] = useState('')
  const [token, setToken] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await createCredential(kind, name.trim(), token.trim(), url.trim() || null))
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
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        aria-label={`${label} token name`}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder="Name"
        className="w-36 rounded border border-line-strong bg-app px-3 py-1 text-sm text-fg"
      />
      <input
        type="password"
        autoComplete="off"
        aria-label={`${label} token`}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        placeholder="Paste token"
        className="min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg"
      />
      {urlPlaceholder !== null && (
        <input
          type="url"
          aria-label={`${label} server URL`}
          value={url}
          onChange={(event) => setUrl(event.currentTarget.value)}
          placeholder={`${urlPlaceholder} (empty: from origin)`}
          className={urlInput}
        />
      )}
      <button
        type="button"
        disabled={busy || name.trim() === '' || token.trim() === ''}
        onClick={() => void submit()}
        className={secondary}
      >
        Add
      </button>
      {onCancel !== undefined && (
        <button type="button" disabled={busy} onClick={onCancel} className={secondary}>
          Cancel
        </button>
      )}
      {error !== null && <span className="text-sm text-red-ink">{error}</span>}
    </div>
  )
}

function CredentialRow({
  credential,
  onChanged,
}: {
  credential: ForgeCredential
  onChanged: () => void
}) {
  const urlPlaceholder = FORGES.find((f) => f.kind === credential.kind)?.urlPlaceholder ?? null
  const [token, setToken] = useState('')
  const [url, setUrl] = useState(credential.url ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setUrl(credential.url ?? ''), [credential.url])

  const run = async (
    method: 'PATCH' | 'DELETE',
    body?: { token: string } | { url: string | null },
  ) => {
    setBusy(true)
    setError(null)
    const err = await send(method, `/api/forge-credentials/${credential.id}`, body)
    setBusy(false)
    if (err !== null) setError(err)
    else setToken('')
    onChanged()
  }

  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="w-40 truncate text-sm text-fg-strong">{credential.name}</span>
      <input
        type="password"
        autoComplete="off"
        aria-label={`New token for ${credential.name}`}
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        placeholder="Replace token"
        className="min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg"
      />
      <button
        type="button"
        disabled={busy || token.trim() === ''}
        onClick={() => void run('PATCH', { token: token.trim() })}
        className={secondary}
      >
        Rotate
      </button>
      {urlPlaceholder !== null && (
        <>
          <input
            type="url"
            aria-label={`Server URL for ${credential.name}`}
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder={`${urlPlaceholder} (empty: from origin)`}
            className={urlInput}
          />
          <button
            type="button"
            disabled={busy || url.trim() === (credential.url ?? '')}
            onClick={() => void run('PATCH', { url: url.trim() || null })}
            className={secondary}
          >
            Save URL
          </button>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void run('DELETE')}
        className={secondary}
      >
        Delete
      </button>
      {error !== null && <span className="text-sm text-red-ink">{error}</span>}
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
  return (
    <div className={`${card} mt-4`}>
      <h2 className="mb-1 text-sm text-fg-muted">Forge tokens</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Shared by every repository. A repository uses the token it picked, or the only token for its
        forge. Stored in amagi's state directory, never in a repository.
      </p>
      {FORGES.map(({ kind, label }) => (
        <div key={kind} className="mt-3">
          <h3 className="text-sm text-fg-strong">{label}</h3>
          <ul className="divide-y divide-line">
            {credentials
              .filter((credential) => credential.kind === kind)
              .map((credential) => (
                <CredentialRow key={credential.id} credential={credential} onChanged={onChanged} />
              ))}
          </ul>
          <NewTokenForm kind={kind} onCreated={onChanged} />
        </div>
      ))}
    </div>
  )
}

function tokenStatus(
  state: ForgeTokenState,
  credentials: ForgeCredential[],
  cli: string,
  env: string,
): string {
  const name = credentials.find((credential) => credential.id === state.credential)?.name
  switch (state.source) {
    case 'picked':
      return `Using ${name}`
    case 'only':
      return `Using ${name} (only token)`
    case 'environment':
      return `Using ${env} from the environment`
    case null:
      return `No token (${cli}, ${env})`
  }
}

export function RepositoryForge({
  repo,
  credentials,
  onCredentialsChanged,
}: {
  repo: Pick<Repo, 'key'>
  credentials: ForgeCredential[]
  onCredentialsChanged: () => void
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
            {FORGES.map(({ kind, label, cli, env }) => {
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
                      {tokenStatus(state, credentials, cli, env)}
                    </span>
                  </div>
                  {adding === kind && (
                    <div className="mt-2">
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
                    </div>
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

export function RepositorySettingsCard({
  repo,
  credentials,
  onChanged,
  onCredentialsChanged,
}: {
  repo: Repo
  credentials: ForgeCredential[]
  onChanged: () => void
  onCredentialsChanged: () => void
}) {
  return (
    <div className="mt-6 space-y-4">
      <RepositoryParticipation repo={repo} onChanged={onChanged} />
      <RepositoryReview key={repo.key} repo={repo} />
      <RepositoryChecks key={repo.key} repo={repo} onChanged={onChanged} />
      <RepositoryForge
        key={repo.key}
        repo={repo}
        credentials={credentials}
        onCredentialsChanged={onCredentialsChanged}
      />
      <RepositoryGitIdentity repo={repo} />
    </div>
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
