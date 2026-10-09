import { type ChangeEvent, useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { setDateFormatPref, useDateFormatPref } from '../date-format.ts'
import { DEFAULT_DATE_FORMAT, fmtDateTime } from '../format.ts'
import { useDashboard } from '../store.tsx'
import {
  addTheme,
  createCustomTheme,
  deleteSelectedTheme,
  getSelectedThemeForExport,
  renameSelectedTheme,
  setSelectedTheme,
  setThemePref,
  type ThemePref,
  updateThemeColor,
  useAppearance,
} from '../theme.ts'
import {
  exportBase24Theme,
  exportDtcgTheme,
  parseThemeImport,
  THEME_COLOR_ROLES,
} from '../theme-colors.ts'
import { FleetWorkersSettings } from './fleet.tsx'
import { ProfilesSettings } from './profiles-settings.tsx'
import {
  ForgeCredentials,
  RepositorySettingsCard,
  useForgeCredentials,
} from './repository-settings.tsx'
import { send, Toggle } from './settings-ui.tsx'

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function Appearance() {
  const appearance = useAppearance()
  const dateFormat = useDateFormatPref()
  const [url, setUrl] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)
  const selectedTheme = appearance.themes.find(({ id }) => id === appearance.selectedThemeId)
  const [themeName, setThemeName] = useState(() => selectedTheme?.name ?? '')
  const colors = appearance.colors

  const importText = (text: string, source?: string) => {
    const theme = parseThemeImport(text, 'imported', source)
    addTheme(theme)
    setThemeName(theme.name)
    setImportResult(`Imported ${theme.name}`)
  }

  const importFromUrl = async () => {
    setImportBusy(true)
    setImportResult(null)
    try {
      let parsedUrl = new URL(url.trim())
      const githubFile = parsedUrl.href.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/,
      )
      if (githubFile) {
        parsedUrl = new URL(
          `https://raw.githubusercontent.com/${githubFile[1]}/${githubFile[2]}/${githubFile[3]}/${githubFile[4]}`,
        )
      }
      if (parsedUrl.protocol !== 'https:') throw new Error('Use an HTTPS raw file URL')
      const response = await fetch(parsedUrl, {
        mode: 'cors',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
      if (Number(response.headers.get('content-length')) > 512_000) {
        throw new Error('Theme file is larger than 512 KB')
      }
      const text = await response.text()
      importText(text, parsedUrl.href)
    } catch (error) {
      setImportResult(error instanceof Error ? error.message : String(error))
    } finally {
      setImportBusy(false)
    }
  }

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setImportResult(null)
    try {
      importText(await file.text(), file.name)
    } catch (error) {
      setImportResult(error instanceof Error ? error.message : String(error))
    }
  }

  const downloadTheme = (format: 'dtcg' | 'base24') => {
    const theme = getSelectedThemeForExport()
    const baseName = theme.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const content =
      format === 'dtcg' ? exportDtcgTheme(theme) : exportBase24Theme(theme, appearance.mode)
    const extension = format === 'dtcg' ? 'tokens.json' : `${appearance.mode}.yaml`
    const type = format === 'dtcg' ? 'application/json' : 'text/yaml'
    const objectUrl = URL.createObjectURL(new Blob([content], { type }))
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = `${baseName || 'amagi-theme'}.${extension}`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-1 text-sm text-fg-muted">Color mode</h2>
        <p className="mb-3 text-sm text-fg-faint">
          {appearance.modePref === 'system'
            ? `Following your OS appearance, currently ${appearance.mode}.`
            : `Using ${appearance.mode} mode.`}
        </p>
        <div className="inline-flex gap-1 rounded border border-line-strong p-1">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={appearance.modePref === option.value}
              onClick={() => setThemePref(option.value)}
              className={`rounded px-3 py-1 text-sm ${
                appearance.modePref === option.value
                  ? 'bg-raised text-fg-strong'
                  : 'text-fg-muted hover:bg-raised hover:text-fg'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-1 text-sm text-fg-muted">Color theme</h2>
        <p className="mb-3 text-sm text-fg-faint">
          Theme choices and custom colors are stored in this browser.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Color theme"
            value={appearance.selectedThemeId}
            onChange={(event) => {
              const id = event.currentTarget.value
              setThemeName(appearance.themes.find((theme) => theme.id === id)?.name ?? '')
              setSelectedTheme(id)
            }}
            className="min-w-52 rounded border border-line-strong bg-app px-3 py-2 text-sm text-fg"
          >
            <option value="default">Default: Gruvbox dark / Solarized light</option>
            {appearance.themes.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
          {appearance.selectedThemeId === 'default' ? (
            <button
              type="button"
              onClick={() => {
                createCustomTheme()
                setThemeName('Custom theme')
              }}
              className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-raised"
            >
              Customize default
            </button>
          ) : (
            <button
              type="button"
              onClick={deleteSelectedTheme}
              className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-red-ink hover:bg-raised"
            >
              Delete theme
            </button>
          )}
          <button
            type="button"
            onClick={() => downloadTheme('dtcg')}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-raised"
          >
            Export DTCG JSON
          </button>
          <button
            type="button"
            onClick={() => downloadTheme('base24')}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-raised"
          >
            Export Base24 YAML
          </button>
        </div>

        {selectedTheme !== undefined && colors !== null && (
          <div className="mt-4 border-t border-line pt-4">
            <label htmlFor="theme-name" className="mb-1 block text-sm text-fg-muted">
              Theme name
            </label>
            <input
              id="theme-name"
              type="text"
              value={themeName}
              onChange={(event) => {
                const nextName = event.currentTarget.value
                setThemeName(nextName)
                if (nextName.trim() !== '') renameSelectedTheme(nextName)
              }}
              className="mb-4 w-full rounded border border-line-strong bg-app px-3 py-2 text-sm text-fg"
            />
            {[...new Set(THEME_COLOR_ROLES.map(({ group }) => group))].map((group) => (
              <fieldset key={group} className="mb-4">
                <legend className="mb-2 text-sm text-fg-muted">{group}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {THEME_COLOR_ROLES.filter((role) => role.group === group).map(
                    ({ key, label }) => (
                      <label
                        key={key}
                        className="flex items-center justify-between gap-3 text-sm text-fg"
                      >
                        <span>{label}</span>
                        <input
                          aria-label={label}
                          type="color"
                          value={colors[key]}
                          onChange={(event) =>
                            updateThemeColor(appearance.mode, key, event.currentTarget.value)
                          }
                          className="h-8 w-12 cursor-pointer rounded border border-line-strong bg-app p-1"
                        />
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
            ))}
            <p className="text-xs text-fg-faint">
              Editing the {appearance.mode} variant. Light and dark colors are saved separately.
            </p>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
        <h2 className="mb-1 text-sm text-fg-muted">Import a theme</h2>
        <p className="mb-3 text-sm text-fg-faint">
          Import Base16 or Base24 YAML from a raw repository URL, or Amagi DTCG JSON. GitHub file
          links are converted to raw URLs. Single-variant imports use Amagi defaults for the other
          mode.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Raw theme URL"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://raw.githubusercontent.com/.../theme.yaml"
            className="min-w-64 flex-1 rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
          />
          <button
            type="button"
            disabled={importBusy || url.trim() === ''}
            onClick={() => void importFromUrl()}
            className="rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-raised disabled:opacity-50"
          >
            {importBusy ? 'Importing…' : 'Import URL'}
          </button>
          <label className="cursor-pointer rounded border border-line-strong bg-surface px-3 py-2 text-sm text-fg hover:bg-raised">
            Import file
            <input
              type="file"
              accept=".json,.yaml,.yml,application/json,text/yaml,text/x-yaml"
              onChange={(event) => void importFile(event)}
              className="sr-only"
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-fg-faint">
          Example:{' '}
          <code>
            curl -fsSL
            https://raw.githubusercontent.com/tinted-theming/schemes/spec-0.11/base16/ayu-mirage.yaml
            -o ayu-mirage.yaml
          </code>
        </p>
        {importResult !== null && (
          <p role="status" className="mt-2 text-sm text-fg-muted">
            {importResult}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-line bg-surface p-4">
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
  const [activeTab, setActiveTab] = useState<
    'general' | 'appearance' | 'profiles' | 'workers' | 'repositories'
  >('general')
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [autoRebase, setAutoRebase] = useState(false)
  const [rebaseBusy, setRebaseBusy] = useState(false)
  const [rebaseResult, setRebaseResult] = useState<string | null>(null)
  const [staleMaxParallel, setStaleMaxParallel] = useState(false)
  const [ntfyTopic, setNtfyTopic] = useState('')
  const [ntfyServer, setNtfyServer] = useState('https://ntfy.sh')
  const [savedNtfyTopic, setSavedNtfyTopic] = useState('')
  const [savedNtfyServer, setSavedNtfyServer] = useState('https://ntfy.sh')
  const [ntfyBusy, setNtfyBusy] = useState(false)
  const [ntfyError, setNtfyError] = useState<string | null>(null)
  const [ntfySaved, setNtfySaved] = useState(false)
  const [desktopFailureAlerts, setDesktopFailureAlerts] = useState(false)
  const [desktopBusy, setDesktopBusy] = useState(false)
  const [desktopResult, setDesktopResult] = useState<string | null>(null)
  const [ntfyTestBusy, setNtfyTestBusy] = useState(false)
  const [ntfyTestResult, setNtfyTestResult] = useState<string | null>(null)
  const repo = repos?.find(({ key }) => key === selectedRepo) ?? repos?.[0]
  const forgeCredentials = useForgeCredentials()

  useEffect(() => {
    if (selected === null) return
    let active = true
    setLoaded(false)
    setNtfyError(null)
    setNtfySaved(false)
    setRebaseResult(null)
    setDesktopResult(null)
    setNtfyTestResult(null)
    fetch(`${apiBase}/api/repos/${selected}/settings`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              autoRebase: boolean
              staleMaxParallel: boolean
              ntfyTopic: string | null
              ntfyServer: string
              desktopFailureAlerts: boolean
            }>)
          : null,
      )
      .then((body) => {
        if (!active) return
        setAutoRebase(body?.autoRebase ?? false)
        setLoaded(true)
        setStaleMaxParallel(body?.staleMaxParallel ?? false)
        setNtfyTopic(body?.ntfyTopic ?? '')
        setNtfyServer(body?.ntfyServer ?? 'https://ntfy.sh')
        setSavedNtfyTopic(body?.ntfyTopic ?? '')
        setSavedNtfyServer(body?.ntfyServer ?? 'https://ntfy.sh')
        setDesktopFailureAlerts(body?.desktopFailureAlerts ?? false)
      })
      .catch(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [selected])

  const saveNtfy = async () => {
    if (selected === null) return
    setNtfyBusy(true)
    setNtfyError(null)
    setNtfySaved(false)
    try {
      const res = await fetch(`${apiBase}/api/repos/${selected}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ntfyTopic: ntfyTopic.trim(), ntfyServer: ntfyServer.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const body = (await res.json()) as { ntfyTopic: string | null; ntfyServer: string }
      setNtfyTopic(body.ntfyTopic ?? '')
      setNtfyServer(body.ntfyServer)
      setSavedNtfyTopic(body.ntfyTopic ?? '')
      setSavedNtfyServer(body.ntfyServer)
      setNtfySaved(true)
    } catch (err) {
      setNtfyError(err instanceof Error ? err.message : String(err))
    } finally {
      setNtfyBusy(false)
    }
  }

  const saveDesktopFailureAlerts = async (enabled: boolean) => {
    if (selected === null) return
    setDesktopBusy(true)
    setDesktopResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${selected}/settings`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ desktopFailureAlerts: enabled }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setDesktopFailureAlerts(enabled)
      setDesktopResult('Saved')
    } catch (err) {
      setDesktopResult(err instanceof Error ? err.message : String(err))
    } finally {
      setDesktopBusy(false)
    }
  }

  const testNotification = async (channel: 'desktop' | 'ntfy') => {
    if (selected === null) return
    const isDesktop = channel === 'desktop'
    const setBusy = isDesktop ? setDesktopBusy : setNtfyTestBusy
    const setResult = isDesktop ? setDesktopResult : setNtfyTestResult
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch(`${apiBase}/api/repos/${selected}/settings/test-${channel}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = (await res.json()) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setResult('Test notification sent')
    } catch (err) {
      setResult(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

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
            ['appearance', 'Appearance'],
            ['profiles', 'Profiles'],
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
        id="settings-panel-appearance"
        role="tabpanel"
        aria-labelledby="settings-tab-appearance"
        hidden={activeTab !== 'appearance'}
      >
        <Appearance />
      </div>
      <div
        id="settings-panel-general"
        role="tabpanel"
        aria-labelledby="settings-tab-general"
        hidden={activeTab !== 'general'}
      >
        {selected !== null && loaded && (
          <div className="mt-6 rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-1 text-sm text-fg-muted">Automatic rebasing</h2>
            <p className="mb-3 text-sm text-fg-faint">
              Rebase idle Amagi PR branches onto the latest base for {selected}, across all forges.
              Setup and checks must pass before pushing. Conflicts or failed checks stop the rebase.
              Requires repository watchers to be enabled.
            </p>
            <Toggle
              on={autoRebase}
              label="Automatically rebase PR branches"
              title="Persisted for this repository, disabled by default."
              disabled={rebaseBusy}
              onClick={() => {
                const enabled = !autoRebase
                setRebaseBusy(true)
                setRebaseResult(null)
                void send('PATCH', `/api/repos/${selected}/settings`, { autoRebase: enabled })
                  .then((error) => {
                    if (error === null) setAutoRebase(enabled)
                    setRebaseResult(error ?? 'Saved')
                  })
                  .finally(() => setRebaseBusy(false))
              }}
            />
            {rebaseResult !== null && (
              <p role="status" className="mt-2 text-sm text-fg-faint">
                {rebaseResult}
              </p>
            )}
          </div>
        )}
        {selected !== null && loaded && (
          <div className="mt-6 rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-1 text-sm text-fg-muted">Desktop notifications</h2>
            <p className="mb-3 text-sm text-fg-faint">
              Desktop delivery stays enabled. Choose whether delivery failures appear in the
              dashboard.
            </p>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={desktopFailureAlerts}
                disabled={desktopBusy}
                onChange={(event) => void saveDesktopFailureAlerts(event.currentTarget.checked)}
              />
              Show desktop delivery failures in the dashboard
            </label>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={desktopBusy}
                onClick={() => void testNotification('desktop')}
                className="rounded border border-line-strong bg-surface px-3 py-1 text-sm text-fg hover:bg-raised disabled:opacity-50"
              >
                {desktopBusy ? 'Sending…' : 'Send test desktop notification'}
              </button>
              {desktopResult !== null && (
                <span role="status" className="text-sm text-fg-faint">
                  {desktopResult}
                </span>
              )}
            </div>
          </div>
        )}
        {selected !== null && loaded && (
          <div className="mt-6 rounded-lg border border-line bg-surface p-4">
            <h2 className="mb-1 text-sm text-fg-muted">ntfy notifications</h2>
            <p className="mb-3 text-sm text-fg-faint">
              Configure ntfy for {selected}. Leave the topic empty to disable ntfy notifications.
            </p>
            <label htmlFor="ntfy-topic" className="mb-1 block text-sm text-fg-muted">
              Topic
            </label>
            <input
              id="ntfy-topic"
              type="text"
              value={ntfyTopic}
              onChange={(event) => {
                setNtfyTopic(event.currentTarget.value)
                setNtfySaved(false)
              }}
              className="mb-3 w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
            />
            <label htmlFor="ntfy-server" className="mb-1 block text-sm text-fg-muted">
              Server URL
            </label>
            <input
              id="ntfy-server"
              type="url"
              value={ntfyServer}
              onChange={(event) => {
                setNtfyServer(event.currentTarget.value)
                setNtfySaved(false)
              }}
              className="w-full rounded border border-line-strong bg-app px-3 py-2 font-mono text-sm text-fg"
            />
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={ntfyBusy || ntfyServer.trim() === ''}
                onClick={() => void saveNtfy()}
                className="rounded border border-line-strong bg-surface px-3 py-1 text-sm text-fg hover:bg-raised disabled:opacity-50"
              >
                {ntfyBusy ? 'Saving…' : 'Save'}
              </button>
              {ntfySaved && <span className="text-sm text-fg-faint">Saved</span>}
            </div>
            <button
              type="button"
              disabled={
                ntfyTestBusy ||
                savedNtfyTopic === '' ||
                ntfyTopic.trim() !== savedNtfyTopic ||
                ntfyServer.trim() !== savedNtfyServer
              }
              onClick={() => void testNotification('ntfy')}
              className="mt-3 rounded border border-line-strong bg-surface px-3 py-1 text-sm text-fg hover:bg-raised disabled:opacity-50"
            >
              {ntfyTestBusy ? 'Sending…' : 'Send test ntfy notification'}
            </button>
            {ntfyTestResult !== null && (
              <p role="status" className="mt-2 text-sm text-fg-faint">
                {ntfyTestResult}
              </p>
            )}
            {ntfyError !== null && (
              <p role="alert" className="mt-2 text-sm text-red-ink">
                {ntfyError}
              </p>
            )}
          </div>
        )}
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
        id="settings-panel-profiles"
        role="tabpanel"
        aria-labelledby="settings-tab-profiles"
        hidden={activeTab !== 'profiles'}
      >
        <ProfilesSettings />
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
        <ForgeCredentials
          credentials={forgeCredentials.credentials}
          onChanged={forgeCredentials.reload}
        />
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
            <RepositorySettingsCard
              repo={repo}
              credentials={forgeCredentials.credentials}
              onChanged={refreshRepos}
              onCredentialsChanged={forgeCredentials.reload}
            />
          </div>
        ) : repo !== undefined ? (
          <RepositorySettingsCard
            repo={repo}
            credentials={forgeCredentials.credentials}
            onChanged={refreshRepos}
            onCredentialsChanged={forgeCredentials.reload}
          />
        ) : null}
      </div>
    </section>
  )
}
