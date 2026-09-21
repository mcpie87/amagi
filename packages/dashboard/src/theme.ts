import { useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'amagi:theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'
// the browser chrome tint, kept in step with --color-app in index.css
const THEME_COLOR: Record<Theme, string> = { dark: '#0e0e11', light: '#f7f7f8' }

function readPref(): ThemePref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // storage unavailable (private mode, blocked), follow the OS
    return 'system'
  }
}

let pref = readPref()
const listeners = new Set<() => void>()

function systemTheme(): Theme {
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark'
}

function effective(): Theme {
  return pref === 'system' ? systemTheme() : pref
}

/** Same attribute the pre-paint script in index.html sets; keep the two in step. */
function apply() {
  const theme = effective()
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
}

function announce() {
  for (const listener of listeners) listener()
}

window.matchMedia(LIGHT_QUERY).addEventListener('change', () => {
  if (pref !== 'system') return
  apply()
  announce()
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
    if (next === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // storage unavailable, the choice just won't persist
  }
  apply()
  announce()
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref)
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, effective)
}
