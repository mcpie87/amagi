import { afterEach, describe, expect, test } from 'bun:test'
import { currentTheme, setTheme, THEME_STORAGE_KEY } from './theme.ts'

function installGlobals(prefersDark: boolean) {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} as Record<string, string> },
  }
  ;(globalThis as { window?: unknown }).window = {
    matchMedia: (query: string) => ({ matches: query.includes('dark') && prefersDark }),
  }
  return store
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).window
})

describe('theme', () => {
  test('falls back to the OS preference when nothing is stored', () => {
    const store = installGlobals(true)
    store.delete(THEME_STORAGE_KEY)
    expect(currentTheme()).toBe('dark')
    installGlobals(false)
    store.delete(THEME_STORAGE_KEY)
    expect(currentTheme()).toBe('light')
  })

  test('prefers the stored value over the OS preference', () => {
    installGlobals(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    expect(currentTheme()).toBe('dark')
  })

  test('setTheme persists and applies to the document', () => {
    installGlobals(true)
    setTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('ignores an invalid stored value', () => {
    const store = installGlobals(false)
    store.set(THEME_STORAGE_KEY, 'sepia')
    expect(currentTheme()).toBe('light')
  })
})
