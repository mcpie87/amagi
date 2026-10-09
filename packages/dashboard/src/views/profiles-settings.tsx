import type { ProfileConfig } from '@amagi/core/config'
import { useEffect, useId, useRef, useState } from 'react'
import { apiBase } from '../api.ts'
import { secondary, send } from './settings-ui.tsx'

type ProfileOptions = {
  models: Record<string, string[]>
  efforts: Record<string, string[]>
}

const input = 'w-full rounded border border-line-strong bg-sunken px-3 py-2 text-sm text-fg-strong'
const primary =
  'rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-on-solid hover:bg-sky-500 disabled:opacity-50'

function ProfileForm({
  initial,
  profiles,
  options,
  busy,
  onSave,
  onClose,
}: {
  initial: ProfileConfig | null
  profiles: ProfileConfig[]
  options: ProfileOptions | null
  busy: boolean
  onSave: (profile: ProfileConfig) => Promise<string | null>
  onClose: () => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState<ProfileConfig>(
    initial ?? { profile_name: '', harness: 'claude', model: '', effort: '' },
  )
  const [customModel, setCustomModel] = useState(
    initial !== null && !options?.models[initial.harness]?.includes(initial.model),
  )
  const [customEffort, setCustomEffort] = useState(
    initial !== null && !options?.efforts[initial.harness]?.includes(initial.effort),
  )
  const [error, setError] = useState<string | null>(null)
  const duplicate = profiles.some(
    (profile) => profile !== initial && profile.profile_name === draft.profile_name.trim(),
  )
  const valid =
    !duplicate &&
    [draft.profile_name, draft.model, draft.effort].every((value) => value.trim() !== '')

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-line-strong bg-surface p-0 text-fg shadow-xl backdrop:bg-black/60"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (!valid || busy) return
          setError(null)
          const result = await onSave({
            ...draft,
            profile_name: draft.profile_name.trim(),
            model: draft.model.trim(),
            effort: draft.effort.trim(),
          })
          if (result === null) onClose()
          else setError(result)
        }}
      >
        <div className="border-b border-line px-5 py-4">
          <h2 id={`${id}-title`} className="text-base font-semibold text-fg-strong">
            {initial === null ? 'New profile' : 'Edit profile'}
          </h2>
        </div>
        <fieldset disabled={busy} className="space-y-4 p-5">
          <label className="block text-sm text-fg-muted">
            Profile name
            <input
              value={draft.profile_name}
              onChange={(event) => setDraft({ ...draft, profile_name: event.target.value })}
              placeholder="e.g. Careful reviewer"
              required
              className={`${input} mt-1`}
            />
          </label>
          {duplicate && (
            <p className="text-xs text-red-ink">A profile with this name already exists.</p>
          )}
          <label className="block text-sm text-fg-muted">
            Harness
            <select
              value={draft.harness}
              onChange={(event) => {
                setCustomModel(false)
                setCustomEffort(false)
                setDraft({
                  ...draft,
                  harness: event.target.value as ProfileConfig['harness'],
                  model: '',
                  effort: '',
                })
              }}
              className={`${input} mt-1`}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </label>
          <div>
            <label className="block text-sm text-fg-muted" htmlFor={`${id}-model`}>
              Model
            </label>
            <select
              id={`${id}-model`}
              value={customModel ? '__custom' : draft.model}
              onChange={(event) => {
                const custom = event.target.value === '__custom'
                setCustomModel(custom)
                setDraft({ ...draft, model: custom ? '' : event.target.value })
              }}
              className={`${input} mt-1`}
            >
              <option value="" disabled>
                Choose a model
              </option>
              {options?.models[draft.harness]?.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              <option value="__custom">Custom model...</option>
            </select>
            {customModel && (
              <input
                aria-label="Custom model"
                value={draft.model}
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                placeholder="Model ID"
                required
                className={`${input} mt-2 font-mono`}
              />
            )}
          </div>
          <div>
            <label className="block text-sm text-fg-muted" htmlFor={`${id}-effort`}>
              Effort
            </label>
            <select
              id={`${id}-effort`}
              value={customEffort ? '__custom' : draft.effort}
              onChange={(event) => {
                const custom = event.target.value === '__custom'
                setCustomEffort(custom)
                setDraft({ ...draft, effort: custom ? '' : event.target.value })
              }}
              className={`${input} mt-1`}
            >
              <option value="" disabled>
                Choose an effort
              </option>
              {options?.efforts[draft.harness]?.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
              <option value="__custom">Custom effort...</option>
            </select>
            {customEffort && (
              <input
                aria-label="Custom effort"
                value={draft.effort}
                onChange={(event) => setDraft({ ...draft, effort: event.target.value })}
                placeholder="Reasoning effort"
                required
                className={`${input} mt-2`}
              />
            )}
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-red-ink">
              {error}
            </p>
          )}
        </fieldset>
        <div className="flex justify-end gap-2 border-t border-line bg-sunken/40 px-5 py-3">
          <button type="button" disabled={busy} onClick={onClose} className={secondary}>
            Cancel
          </button>
          <button type="submit" disabled={!valid || busy} className={primary}>
            {busy ? 'Saving...' : initial === null ? 'Create profile' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function ProfilesSettings() {
  const [profiles, setProfiles] = useState<ProfileConfig[] | null>(null)
  const [options, setOptions] = useState<ProfileOptions | null>(null)
  const [editing, setEditing] = useState<ProfileConfig | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    fetch(`${apiBase}/api/profiles`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as { profiles: ProfileConfig[] } & ProfileOptions
      })
      .then((body) => {
        if (!active) return
        setProfiles(body.profiles)
        setOptions({ models: body.models, efforts: body.efforts })
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load profiles')
      })
    return () => {
      active = false
    }
  }, [])

  const persist = async (next: ProfileConfig[]) => {
    setBusy(true)
    setError(null)
    const result = await send('PUT', '/api/profiles', { profiles: next })
    if (result === null) setProfiles(next)
    setBusy(false)
    return result
  }

  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-fg-muted">
          Harness, model and effort presets for all repositories.
        </p>
        <button
          type="button"
          disabled={profiles === null || busy}
          onClick={() => setEditing('new')}
          className={`${primary} shrink-0`}
        >
          Add profile
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="mb-3 text-sm text-red-ink">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        {profiles === null ? (
          <p className="p-8 text-center text-sm text-fg-faint">
            {error === null ? 'Loading profiles...' : 'Profiles could not be loaded.'}
          </p>
        ) : profiles.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-medium text-fg-strong">No profiles yet</p>
            <p className="mt-1 text-sm text-fg-faint">
              Add a profile to save a harness, model and effort combination.
            </p>
          </div>
        ) : (
          <table className="w-full whitespace-nowrap text-left text-sm">
            <thead className="border-b border-line bg-sunken/40 text-xs text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Harness
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Model
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Effort
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {profiles.map((profile) => (
                <tr key={profile.profile_name} className="hover:bg-raised/40">
                  <th scope="row" className="px-4 py-3 font-medium text-fg-strong">
                    {profile.profile_name}
                  </th>
                  <td className="px-4 py-3 text-fg-muted">{profile.harness}</td>
                  <td className="px-4 py-3 font-mono text-xs text-fg-muted">{profile.model}</td>
                  <td className="px-4 py-3">
                    <span className="rounded border border-line px-2 py-0.5 text-xs text-fg-muted">
                      {profile.effort}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-3">
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Edit ${profile.profile_name}`}
                        onClick={() => setEditing(profile)}
                        className="text-fg-muted hover:text-fg-strong disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={`Delete ${profile.profile_name}`}
                        onClick={async () => {
                          if (!window.confirm(`Delete profile ${profile.profile_name}?`)) return
                          const result = await persist(
                            profiles.filter((entry) => entry !== profile),
                          )
                          if (result !== null) setError(result)
                        }}
                        className="text-fg-faint hover:text-red-ink disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing !== null && profiles !== null && (
        <ProfileForm
          initial={editing === 'new' ? null : editing}
          profiles={profiles}
          options={options}
          busy={busy}
          onSave={(profile) =>
            persist(
              editing === 'new'
                ? [...profiles, profile]
                : profiles.map((entry) => (entry === editing ? profile : entry)),
            )
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
