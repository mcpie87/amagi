import { useSyncExternalStore } from 'react'
import {
  DEFAULT_THEME_COLORS,
  THEME_COLOR_ROLES,
  type ThemeColorKey,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariant,
} from './theme-colors.ts'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = ThemeVariant

const PREF_KEY = 'amagi:theme'
const SELECTION_KEY = 'amagi:theme-selection'
const THEMES_KEY = 'amagi:custom-themes'
const DEFAULT_THEME_ID = 'default'
const LIGHT_QUERY = '(prefers-color-scheme: light)'
const THEME_COLOR: Record<Theme, string> = { dark: '#282828', light: '#fdf6e3' }
const listeners = new Set<() => void>()
const STYLE_PROPERTIES = [
  ...THEME_COLOR_ROLES.map(({ key }) => `--color-${key}`),
  '--selection-bg',
  '--selection-fg',
  '--code-bg',
  '--shadow-color',
]

function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(PREF_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

function readThemes(): ThemeDefinition[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(THEMES_KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter(isThemeDefinition).slice(0, 32)
  } catch {
    return []
  }
}

function isThemeDefinition(value: unknown): value is ThemeDefinition {
  if (typeof value !== 'object' || value === null) return false
  const theme = value as Partial<ThemeDefinition>
  if (typeof theme.id !== 'string' || typeof theme.name !== 'string') return false
  if (typeof theme.variants !== 'object' || theme.variants === null) return false
  return (['light', 'dark'] as const).every((variant) => {
    const colors = theme.variants?.[variant]
    return (
      typeof colors === 'object' &&
      colors !== null &&
      THEME_COLOR_ROLES.every(({ key }) => /^#[\da-f]{6}$/i.test((colors as ThemeColors)[key]))
    )
  })
}

let pref = readPref()
let themes = readThemes()
let selectedThemeId = (() => {
  try {
    const id = localStorage.getItem(SELECTION_KEY)
    return id !== null && themes.some((theme) => theme.id === id) ? id : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
})()

function systemTheme(): Theme {
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

function effective(): Theme {
  return pref === 'system' ? systemTheme() : pref
}

function selectedTheme(): ThemeDefinition | undefined {
  return themes.find((theme) => theme.id === selectedThemeId)
}

function apply(): AppearanceSnapshot {
  const mode = effective()
  const root = document.documentElement
  root.dataset.theme = mode
  for (const property of STYLE_PROPERTIES) root.style.removeProperty(property)

  const colors = selectedTheme()?.variants[mode]
  if (colors !== undefined) {
    root.dataset.customTheme = 'true'
    root.style.colorScheme = mode
    for (const { key } of THEME_COLOR_ROLES) {
      root.style.setProperty(`--color-${key}`, colors[key])
    }
    root.style.setProperty('--selection-bg', colors.raised)
    root.style.setProperty('--selection-fg', colors['fg-strong'])
    root.style.setProperty('--code-bg', `color-mix(in srgb, ${colors.sunken} 80%, transparent)`)
    root.style.setProperty(
      '--shadow-color',
      `color-mix(in srgb, ${colors.app} ${mode === 'dark' ? 50 : 16}%, transparent)`,
    )
  } else {
    delete root.dataset.customTheme
    root.style.removeProperty('color-scheme')
  }

  const appColor = colors?.app ?? THEME_COLOR[mode]
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', appColor)
  return {
    modePref: pref,
    mode,
    selectedThemeId,
    themes,
    colors: colors ?? null,
  }
}

let snapshot = apply()

function announce() {
  snapshot = apply()
  for (const listener of listeners) listener()
}

function persistThemes() {
  try {
    localStorage.setItem(THEMES_KEY, JSON.stringify(themes))
    localStorage.setItem(SELECTION_KEY, selectedThemeId)
  } catch {
    // Keep the current selection for this page even when storage is unavailable.
  }
}

window.matchMedia(LIGHT_QUERY).addEventListener('change', () => {
  if (pref === 'system') announce()
})

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setThemePref(next: ThemePref) {
  pref = next
  try {
    if (next === 'system') localStorage.removeItem(PREF_KEY)
    else localStorage.setItem(PREF_KEY, next)
  } catch {
    // The choice applies until this page closes.
  }
  announce()
}

export function setSelectedTheme(id: string) {
  if (id !== DEFAULT_THEME_ID && !themes.some((theme) => theme.id === id)) return
  selectedThemeId = id
  persistThemes()
  announce()
}

function makeThemeId() {
  return `theme-${crypto.randomUUID()}`
}

export function createCustomTheme(): string {
  const id = makeThemeId()
  const theme: ThemeDefinition = {
    id,
    name: 'Custom theme',
    variants: {
      light: { ...DEFAULT_THEME_COLORS.light },
      dark: { ...DEFAULT_THEME_COLORS.dark },
    },
  }
  themes = [...themes, theme].slice(-32)
  selectedThemeId = id
  persistThemes()
  announce()
  return id
}

export function addTheme(theme: ThemeDefinition) {
  const imported = { ...theme, id: makeThemeId() }
  themes = [...themes, imported].slice(-32)
  selectedThemeId = imported.id
  persistThemes()
  announce()
}

export function renameSelectedTheme(name: string) {
  if (name.trim() === '') return
  themes = themes.map((theme) =>
    theme.id === selectedThemeId ? { ...theme, name: name.trim().slice(0, 80) } : theme,
  )
  persistThemes()
  announce()
}

export function updateThemeColor(mode: Theme, key: ThemeColorKey, value: string) {
  if (!/^#[\da-f]{6}$/i.test(value)) return
  themes = themes.map((theme) =>
    theme.id === selectedThemeId
      ? {
          ...theme,
          variants: { ...theme.variants, [mode]: { ...theme.variants[mode], [key]: value } },
        }
      : theme,
  )
  persistThemes()
  announce()
}

export function deleteSelectedTheme() {
  if (selectedThemeId === DEFAULT_THEME_ID) return
  themes = themes.filter(({ id }) => id !== selectedThemeId)
  selectedThemeId = DEFAULT_THEME_ID
  persistThemes()
  announce()
}

export function getSelectedThemeForExport(): ThemeDefinition {
  return (
    selectedTheme() ?? {
      id: DEFAULT_THEME_ID,
      name: 'Amagi Default',
      variants: {
        light: { ...DEFAULT_THEME_COLORS.light },
        dark: { ...DEFAULT_THEME_COLORS.dark },
      },
    }
  )
}

export function useAppearance(): AppearanceSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

export type AppearanceSnapshot = {
  modePref: ThemePref
  mode: Theme
  selectedThemeId: string
  themes: ThemeDefinition[]
  colors: ThemeColors | null
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => snapshot.modePref)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => snapshot.mode)
}
