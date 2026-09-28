import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { card, secondary, send, Toggle } from './settings-ui.tsx'

type Repo = { key: string; name: string; workers: boolean; watchers: boolean }
type GitIdentity = { mode: 'path' | 'inline'; value: string }
type ForgeKind = 'github' | 'gitlab' | 'forgejo'
const GIT_IDENTITY_TEMPLATE = '[user]\n\tname = Your Name\n\temail = you@example.com\n'

function RepositoryForge({ repo }: { repo: Pick<Repo, 'key'> }) {
  const [kind, setKind] = useState<ForgeKind>('github')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setLoaded(false)
    setError(null)
    fetch(`${apiBase}/api/repos/${repo.key}/settings`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await responseError(response))
        return (await response.json()) as { forgeKind: ForgeKind }
      })
      .then(({ forgeKind }) => {
        if (active) {
          setKind(forgeKind)
          setLoaded(true)
        }
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

  const save = async (forgeKind: ForgeKind) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    const err = await send('PATCH', `/api/repos/${repo.key}/settings`, { forgeKind })
    setBusy(false)
    if (err !== null) setError(err)
    else {
      setKind(forgeKind)
      setSaved(true)
    }
  }

  return (
    <div className={card}>
      <h2 className="mb-1 text-sm text-fg-muted">Pull request forge</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Select the forge where amagi creates and manages pull requests for this repository.
      </p>
      {!loaded ? (
        <p className="text-sm text-fg-faint">Loading…</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-fg-muted">
            PR target
            <select
              value={kind}
              disabled={busy}
              onChange={(event) => void save(event.currentTarget.value as ForgeKind)}
              className="ml-2 rounded border border-line-strong bg-app px-3 py-2 text-fg"
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
              <option value="forgejo">Forgejo</option>
            </select>
          </label>
          {busy && <span className="text-sm text-fg-faint">Saving…</span>}
          {saved && <span className="text-sm text-fg-faint">Saved</span>}
          {error !== null && (
            <span role="alert" className="text-sm text-red-ink">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

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
