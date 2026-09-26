import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { setDateFormatPref, useDateFormatPref } from '../date-format.ts'
import { DEFAULT_DATE_FORMAT, fmtDateTime } from '../format.ts'
import { useDashboard } from '../store.tsx'
import { setThemePref, type ThemePref, useTheme, useThemePref } from '../theme.ts'
import { FleetWorkersSettings, RepositoryParticipationCard } from './fleet.tsx'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function Appearance() {
  const pref = useThemePref()
  const theme = useTheme()
  const dateFormat = useDateFormatPref()

  return (
    <div className="mt-6 rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-1 text-sm text-fg-muted">Theme</h2>
      <p className="mb-3 text-sm text-fg-faint">
        Stored in this browser only.
        {pref === 'system' ? ` System follows your OS appearance, currently ${theme}.` : ''}
      </p>
      <div className="inline-flex gap-1 rounded border border-line-strong p-1">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={pref === option.value}
            onClick={() => setThemePref(option.value)}
            className={`rounded px-3 py-1 text-sm ${
              pref === option.value
                ? 'bg-raised text-fg-strong'
                : 'text-fg-muted hover:bg-raised hover:text-fg'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="mt-5">
        <label htmlFor="date-format" className="mb-1 block text-sm text-fg-muted">
          Date format
        </label>
        <input
          id="date-format"
          type="text"
          value={dateFormat}
          onChange={(event) => setDateFormatPref(event.currentTarget.value)}
          placeholder={DEFAULT_DATE_FORMAT}
          className="w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
        />
        <p className="mt-1 text-xs text-fg-faint">
          Tokens: YYYY, MM, DD, hh, mm, ss. Example: {fmtDateTime(Date.now(), dateFormat)}.
        </p>
      </div>
    </div>
  )
}

export function SettingsView() {
  const { repos, refreshRepos, selected } = useDashboard()
  const [activeTab, setActiveTab] = useState<'general' | 'workers' | 'repositories'>('general')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [staleMaxParallel, setStaleMaxParallel] = useState(false)
  const repo = repos?.find(({ key }) => key === selectedRepo) ?? repos?.[0]

  useEffect(() => {
    if (selected === null) return
    setLoaded(false)
    fetch(`${apiBase}/api/repos/${selected}/settings`)
      .then((res) => (res.ok ? (res.json() as Promise<{ staleMaxParallel: boolean }>) : null))
      .then((body) => {
        setLoaded(true)
        setStaleMaxParallel(body?.staleMaxParallel ?? false)
      })
      .catch(() => setLoaded(true))
  }, [selected])

  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div
        role="tablist"
        aria-label="Settings sections"
        className="mt-4 flex gap-1 border-b border-line"
      >
        {(
          [
            ['general', 'General'],
            ['workers', 'Workers'],
            ['repositories', 'Repositories'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`settings-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls={`settings-panel-${id}`}
            onClick={() => setActiveTab(id)}
            className={`rounded-t px-3 py-2 text-sm ${
              activeTab === id
                ? 'bg-raised text-fg-strong'
                : 'text-fg-muted hover:bg-raised hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        id="settings-panel-general"
        role="tabpanel"
        aria-labelledby="settings-tab-general"
        hidden={activeTab !== 'general'}
      >
        <Appearance />
        {selected === null ? (
          <p className="mt-6 text-fg-faint">no repository selected</p>
        ) : (
          loaded &&
          staleMaxParallel && (
            <p className="mt-6 text-sm text-amber-ink">
              Notice: loop.maxParallel is ignored; configure workers in the global fleet.
            </p>
          )
        )}
      </div>
      <div
        id="settings-panel-workers"
        role="tabpanel"
        aria-labelledby="settings-tab-workers"
        hidden={activeTab !== 'workers'}
      >
        <FleetWorkersSettings />
      </div>
      <div
        id="settings-panel-repositories"
        role="tabpanel"
        aria-labelledby="settings-tab-repositories"
        hidden={activeTab !== 'repositories'}
      >
        {repos !== null && repos.length > 1 && (
          <div
            role="tablist"
            aria-label="Repositories"
            className="mt-4 flex gap-1 border-b border-line"
          >
            {repos.map((entry) => (
              <button
                key={entry.key}
                id={`repository-tab-${entry.key}`}
                type="button"
                role="tab"
                aria-selected={repo?.key === entry.key}
                aria-controls="repository-panel"
                onClick={() => setSelectedRepo(entry.key)}
                className={`rounded-t px-3 py-2 text-sm ${
                  repo?.key === entry.key
                    ? 'bg-raised text-fg-strong'
                    : 'text-fg-muted hover:bg-raised hover:text-fg'
                }`}
              >
                {entry.name}
              </button>
            ))}
          </div>
        )}
        {repo !== undefined && repos !== null && repos.length > 1 ? (
          <div id="repository-panel" role="tabpanel" aria-labelledby={`repository-tab-${repo.key}`}>
            <RepositoryParticipationCard repo={repo} onChanged={refreshRepos} />
          </div>
        ) : repo !== undefined ? (
          <RepositoryParticipationCard repo={repo} onChanged={refreshRepos} />
        ) : null}
      </div>
    </section>
  )
}
