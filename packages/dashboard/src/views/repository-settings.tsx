import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { card, secondary, send, Toggle } from './settings-ui.tsx'

type Repo = { key: string; name: string; workers: boolean; watchers: boolean }
type GitIdentity = { mode: 'path' | 'inline'; value: string }
type ForgeKind = 'github' | 'gitlab' | 'forgejo'
type ForgeTokenSource = 'repository' | 'environment' | null
type ForgeSettings = { forgeKind: ForgeKind; forgeTokens: Record<ForgeKind, ForgeTokenSource> }

const FORGES: { kind: ForgeKind; label: string; cli: string; env: string }[] = [
  { kind: 'github', label: 'GitHub', cli: 'gh', env: 'GH_TOKEN' },
  { kind: 'gitlab', label: 'GitLab', cli: 'glab', env: 'GITLAB_TOKEN' },
  { kind: 'forgejo', label: 'Forgejo', cli: 'tea', env: 'FORGEJO_TOKEN' },
]

const TOKEN_STATUS: Record<'repository' | 'environment', string> = {
  repository: 'Token set',
  environment: 'Token from environment',
}
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

export function RepositoryForge({ repo }: { repo: Pick<Repo, 'key'> }) {
  const [settings, setSettings] = useState<ForgeSettings | null>(null)
  const [drafts, setDrafts] = useState<Record<ForgeKind, string>>({
    github: '',
    gitlab: '',
    forgejo: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setSettings(null)
    setError(null)
    setDrafts({ github: '', gitlab: '', forgejo: '' })
    fetch(`${apiBase}/api/repos/${repo.key}/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as ForgeSettings
      })
      .then((body) => {
        if (active) setSettings({ forgeKind: body.forgeKind, forgeTokens: body.forgeTokens })
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [repo.key])

  const save = async (patch: {
    forgeKind?: ForgeKind
    forgeTokens?: Partial<Record<ForgeKind, string | null>>
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
      setSettings({ forgeKind: body.forgeKind, forgeTokens: body.forgeTokens })
      for (const kind of Object.keys(patch.forgeTokens ?? {}) as ForgeKind[]) {
        setDrafts((current) => ({ ...current, [kind]: '' }))
      }
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
        Amagi opens pull requests on the selected forge only. Tokens are stored in amagi's state
        directory, never in the repository, and override the environment variable.
      </p>
      {settings === null ? (
        error === null ? (
          <p className="text-sm text-fg-faint">Loading…</p>
        ) : null
      ) : (
        <fieldset disabled={busy}>
          <legend className="sr-only">Pull request forge</legend>
          <ul className="divide-y divide-line">
            {FORGES.map(({ kind, label, cli, env }) => {
              const source = settings.forgeTokens[kind]
              const draft = drafts[kind]
              return (
                <li key={kind} className="flex flex-wrap items-center gap-3 py-2">
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
                  <span className="w-44 text-xs text-fg-faint">
                    {source === null ? `No token (${cli}, ${env})` : TOKEN_STATUS[source]}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    aria-label={`${label} token`}
                    value={draft}
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setDrafts((current) => ({ ...current, [kind]: value }))
                    }}
                    placeholder={source === 'repository' ? 'Replace token' : 'Paste token'}
                    className="min-w-48 flex-1 rounded border border-line-strong bg-app px-3 py-1 font-mono text-sm text-fg"
                  />
                  <button
                    type="button"
                    disabled={draft.trim() === ''}
                    onClick={() => void save({ forgeTokens: { [kind]: draft.trim() } })}
                    className={secondary}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={source !== 'repository'}
                    onClick={() => void save({ forgeTokens: { [kind]: null } })}
                    className={secondary}
                  >
                    Clear
                  </button>
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

export function RepositorySettingsCard({ repo, onChanged }: { repo: Repo; onChanged: () => void }) {
  return (
    <div className="mt-6 space-y-4">
      <RepositoryParticipation repo={repo} onChanged={onChanged} />
      <RepositoryForge repo={repo} />
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
