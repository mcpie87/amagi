import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_THEME_COLORS,
  exportBase24Theme,
  exportDtcgTheme,
  parseThemeImport,
} from './theme-colors.ts'

const BASE16 = `system: "base16"
name: "Sample Dark"
author: "Example"
variant: "dark"
palette:
  base00: "#101010"
  base01: "#202020"
  base02: "#303030"
  base03: "#404040"
  base04: "#505050"
  base05: "#c0c0c0"
  base06: "#d0d0d0"
  base07: "#e0e0e0"
  base08: "#ff0000"
  base09: "#ff8000"
  base0A: "#ffff00"
  base0B: "#00ff00"
  base0C: "#00ffff"
  base0D: "#0000ff"
  base0E: "#ff00ff"
  base0F: "#804000"
`

describe('theme color interchange', () => {
  test('imports Tinted Base16 YAML into dashboard roles', () => {
    const theme = parseThemeImport(BASE16, 'sample')
    expect(theme.name).toBe('Sample Dark')
    expect(theme.variants.dark.app).toBe('#101010')
    expect(theme.variants.dark['red-ink']).toBe('#ff0000')
    expect(theme.variants.dark['blue-ink']).toBe('#0000ff')
    expect(theme.variants.light).toEqual(DEFAULT_THEME_COLORS.light)
  })

  test('imports exported DTCG JSON and preserves both variants', () => {
    const theme = parseThemeImport(BASE16, 'sample')
    const exported = exportDtcgTheme(theme)
    const imported = parseThemeImport(exported, 'round-trip')
    expect(imported.name).toBe(theme.name)
    expect(imported.variants).toEqual(theme.variants)
  })

  test('exports Base24 YAML with all 24 colors and imports it again', () => {
    const theme = parseThemeImport(BASE16, 'sample')
    const yaml = exportBase24Theme(theme, 'dark')
    expect(yaml).toContain('system: "base24"')
    expect(yaml).toContain('base17:')
    const imported = parseThemeImport(yaml, 'base24')
    expect(imported.variants.dark.app).toBe('#101010')
    expect(imported.variants.dark['red-ink']).toBe('#ff0000')
  })

  test('rejects YAML that does not define a complete Base16 palette', () => {
    expect(() => parseThemeImport('name: incomplete\nbase00: "#000000"', 'bad')).toThrow(
      'missing Base16 colors',
    )
  })
})
