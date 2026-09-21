import { afterEach, describe, expect, test } from 'bun:test'

// theme.ts reads window.matchMedia at module load, so the globals have to be in
// place before the dynamic import below.
function installGlobals(osLight: boolean): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
  ;(globalThis as Record<string, unknown>).document = {
    documentElement: { dataset: {} as Record<string, string> },
    querySelector: () => ({ setAttribute: () => {} }),
  }
  ;(globalThis as Record<string, unknown>).window = {
    matchMedia: (query: string) => ({
      matches: query.includes('light') ? osLight : !osLight,
      addEventListener: () => {},
    }),
  }
  return store
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).window
})

describe('theme', () => {
  test('setThemePref persists the choice and applies it', async () => {
    const store = installGlobals(false)
    const { setThemePref } = await import('./theme.ts')
    setThemePref('dark')
    expect(store.get('amagi:theme')).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    setThemePref('light')
    expect(store.get('amagi:theme')).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  test('setThemePref("system") clears the stored choice', async () => {
    const store = installGlobals(true)
    const { setThemePref } = await import('./theme.ts')
    setThemePref('light')
    setThemePref('system')
    expect(store.has('amagi:theme')).toBe(false)
  })
})
