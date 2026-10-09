export type ThemeVariant = 'light' | 'dark'

export const THEME_COLOR_ROLES = [
  { key: 'app', label: 'App background', group: 'Surfaces' },
  { key: 'sidebar', label: 'Sidebar', group: 'Surfaces' },
  { key: 'sunken', label: 'Sunken surface', group: 'Surfaces' },
  { key: 'surface', label: 'Surface', group: 'Surfaces' },
  { key: 'raised', label: 'Raised surface', group: 'Surfaces' },
  { key: 'raised-strong', label: 'Strong raised surface', group: 'Surfaces' },
  { key: 'line', label: 'Border', group: 'Surfaces' },
  { key: 'line-strong', label: 'Strong border', group: 'Surfaces' },
  { key: 'fg-strong', label: 'Strong text', group: 'Text' },
  { key: 'fg', label: 'Text', group: 'Text' },
  { key: 'fg-muted', label: 'Muted text', group: 'Text' },
  { key: 'fg-faint', label: 'Faint text', group: 'Text' },
  { key: 'fg-dim', label: 'Dim text', group: 'Text' },
  { key: 'on-solid', label: 'Text on solid colors', group: 'Text' },
  { key: 'accent', label: 'Accent', group: 'Status and accents' },
  { key: 'neutral-ink', label: 'Neutral', group: 'Status and accents' },
  { key: 'sky-ink', label: 'Sky', group: 'Status and accents' },
  { key: 'blue-ink', label: 'Blue', group: 'Status and accents' },
  { key: 'amber-ink', label: 'Warning', group: 'Status and accents' },
  { key: 'violet-ink', label: 'Violet', group: 'Status and accents' },
  { key: 'cyan-ink', label: 'Cyan', group: 'Status and accents' },
  { key: 'orange-ink', label: 'Orange', group: 'Status and accents' },
  { key: 'emerald-ink', label: 'Success', group: 'Status and accents' },
  { key: 'red-ink', label: 'Error', group: 'Status and accents' },
  { key: 'teal-ink', label: 'Teal', group: 'Status and accents' },
] as const

export type ThemeColorKey = (typeof THEME_COLOR_ROLES)[number]['key']
export type ThemeColors = Record<ThemeColorKey, string>

export type ThemeDefinition = {
  id: string
  name: string
  variants: Record<ThemeVariant, ThemeColors>
  source?: string
}

export const DEFAULT_THEME_COLORS: Record<ThemeVariant, ThemeColors> = {
  dark: {
    app: '#282828',
    sidebar: '#1d2021',
    sunken: '#1d2021',
    surface: '#282828',
    raised: '#3c3836',
    'raised-strong': '#504945',
    line: '#3c3836',
    'line-strong': '#504945',
    'fg-strong': '#fbf1c7',
    fg: '#ebdbb2',
    'fg-muted': '#d5c4a1',
    'fg-faint': '#bdae93',
    'fg-dim': '#928374',
    'on-solid': '#282828',
    accent: '#fabd2f',
    'neutral-ink': '#d5c4a1',
    'sky-ink': '#8ec07c',
    'blue-ink': '#83a598',
    'amber-ink': '#fabd2f',
    'violet-ink': '#d3869b',
    'cyan-ink': '#8ec07c',
    'orange-ink': '#fe8019',
    'emerald-ink': '#b8bb26',
    'red-ink': '#fb4934',
    'teal-ink': '#8ec07c',
  },
  light: {
    app: '#fdf6e3',
    sidebar: '#eee8d5',
    sunken: '#eee8d5',
    surface: '#fdf6e3',
    raised: '#eee8d5',
    'raised-strong': '#d6cfba',
    line: '#eee8d5',
    'line-strong': '#d6cfba',
    'fg-strong': '#073642',
    fg: '#586e75',
    'fg-muted': '#657b83',
    'fg-faint': '#839496',
    'fg-dim': '#93a1a1',
    'on-solid': '#fdf6e3',
    accent: '#268bd2',
    'neutral-ink': '#586e75',
    'sky-ink': '#2aa198',
    'blue-ink': '#268bd2',
    'amber-ink': '#b58900',
    'violet-ink': '#6c71c4',
    'cyan-ink': '#2aa198',
    'orange-ink': '#cb4b16',
    'emerald-ink': '#859900',
    'red-ink': '#dc322f',
    'teal-ink': '#2aa198',
  },
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const BASE16_KEYS = [
  'base00',
  'base01',
  'base02',
  'base03',
  'base04',
  'base05',
  'base06',
  'base07',
  'base08',
  'base09',
  'base0A',
  'base0B',
  'base0C',
  'base0D',
  'base0E',
  'base0F',
] as const
const BASE24_KEYS = [
  'base10',
  'base11',
  'base12',
  'base13',
  'base14',
  'base15',
  'base16',
  'base17',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

function luminance(hex: string): number {
  const channels =
    hex
      .slice(1)
      .match(/../g)
      ?.map((channel) => Number.parseInt(channel, 16) / 255) ?? []
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  )
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function inferredVariant(background: string): ThemeVariant {
  return luminance(background) > 0.45 ? 'light' : 'dark'
}

function roleColors(palette: Record<string, string>, variant: ThemeVariant): ThemeColors {
  const defaults = DEFAULT_THEME_COLORS[variant]
  const get = (key: string, fallback: string) => palette[key] ?? fallback
  return {
    ...defaults,
    app: get('base00', defaults.app),
    sidebar: get('base11', get('base01', defaults.sidebar)),
    sunken: get('base10', get('base00', defaults.sunken)),
    surface: get('base00', defaults.surface),
    raised: get('base01', defaults.raised),
    'raised-strong': get('base02', defaults['raised-strong']),
    line: get('base01', defaults.line),
    'line-strong': get('base02', defaults['line-strong']),
    'fg-strong': get('base06', get('base05', defaults['fg-strong'])),
    fg: get('base05', defaults.fg),
    'fg-muted': get('base04', defaults['fg-muted']),
    'fg-faint': get('base03', defaults['fg-faint']),
    'fg-dim': get('base03', defaults['fg-dim']),
    'on-solid': get('base00', defaults['on-solid']),
    accent: get('base0D', defaults.accent),
    'neutral-ink': get('base04', defaults['neutral-ink']),
    'sky-ink': get('base0C', defaults['sky-ink']),
    'blue-ink': get('base16', get('base0D', defaults['blue-ink'])),
    'amber-ink': get('base13', get('base0A', defaults['amber-ink'])),
    'violet-ink': get('base17', get('base0E', defaults['violet-ink'])),
    'cyan-ink': get('base15', get('base0C', defaults['cyan-ink'])),
    'orange-ink': get('base09', defaults['orange-ink']),
    'emerald-ink': get('base14', get('base0B', defaults['emerald-ink'])),
    'red-ink': get('base12', get('base08', defaults['red-ink'])),
    'teal-ink': get('base15', get('base0C', defaults['teal-ink'])),
  }
}

function paletteFromYaml(text: string): {
  name: string
  variant: ThemeVariant
  palette: Record<string, string>
} {
  const palette: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const color = line.match(/^\s*(base[0-9a-f]{2})\s*:\s*["']?(#[0-9a-f]{6})["']?\s*(?:#.*)?$/i)
    if (color?.[1] && color[2]) {
      palette[`base${color[1].slice(4).toUpperCase()}`] = color[2]
      continue
    }
    const field = line.match(
      /^\s*(system|name|scheme|variant)\s*:\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/i,
    )
    if (field?.[1] && field[2]) metadata[field[1].toLowerCase()] = field[2].trim()
  }
  const missing = BASE16_KEYS.filter((key) => palette[key] === undefined)
  if (missing.length > 0) throw new Error(`missing Base16 colors: ${missing.join(', ')}`)

  const requestedVariant = metadata.variant?.toLowerCase()
  const background = palette.base00
  if (background === undefined) throw new Error('missing Base16 colors: base00')
  const variant =
    requestedVariant === 'light' || requestedVariant === 'dark'
      ? requestedVariant
      : inferredVariant(background)
  const name = metadata.name ?? metadata.scheme ?? 'Imported Base16 theme'
  return { name, variant, palette }
}

function tokenColor(value: unknown): string | undefined {
  if (isHexColor(value)) return value
  if (isRecord(value) && isHexColor(value.$value)) return value.$value
  return undefined
}

function themeFromDtcg(
  root: Record<string, unknown>,
  id: string,
  source?: string,
): ThemeDefinition {
  const colorGroup = isRecord(root.color) ? root.color : null
  if (colorGroup === null) throw new Error('DTCG theme is missing the color group')

  const extension =
    isRecord(root.$extensions) && isRecord(root.$extensions.amagi) ? root.$extensions.amagi : null
  const colors = {} as Record<ThemeVariant, ThemeColors>
  let foundVariant = false
  for (const variant of ['light', 'dark'] as const) {
    const group = isRecord(colorGroup[variant]) ? colorGroup[variant] : null
    if (group === null) continue
    foundVariant = true
    const values: Record<string, string> = {}
    for (const { key } of THEME_COLOR_ROLES) {
      const value = tokenColor(group[key])
      if (value !== undefined) values[key] = value
    }
    const required = ['app', 'surface', 'fg']
    if (required.some((key) => values[key] === undefined)) {
      throw new Error(`${variant} colors must define app, surface, and fg`)
    }
    colors[variant] = { ...DEFAULT_THEME_COLORS[variant], ...values } as ThemeColors
  }

  if (!foundVariant) throw new Error('DTCG theme needs color.light or color.dark tokens')
  colors.light ??= DEFAULT_THEME_COLORS.light
  colors.dark ??= DEFAULT_THEME_COLORS.dark
  const name =
    typeof extension?.name === 'string'
      ? extension.name
      : typeof root.name === 'string'
        ? root.name
        : 'Imported design-token theme'
  return { id, name, variants: colors, ...(source === undefined ? {} : { source }) }
}

export function parseThemeImport(text: string, id: string, source?: string): ThemeDefinition {
  if (text.length > 512_000) throw new Error('theme file is larger than 512 KB')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('invalid JSON theme')
    }
    if (!isRecord(parsed)) throw new Error('theme JSON must be an object')
    return themeFromDtcg(parsed, id, source)
  }

  const { name, variant, palette } = paletteFromYaml(trimmed)
  const other: ThemeVariant = variant === 'dark' ? 'light' : 'dark'
  const variants: Record<ThemeVariant, ThemeColors> = {
    ...DEFAULT_THEME_COLORS,
    [variant]: roleColors(palette, variant),
    [other]: DEFAULT_THEME_COLORS[other],
  }
  return { id, name, variants, ...(source === undefined ? {} : { source }) }
}

export function exportDtcgTheme(theme: ThemeDefinition): string {
  const tokenGroup = (colors: ThemeColors) => ({
    $type: 'color',
    ...Object.fromEntries(THEME_COLOR_ROLES.map(({ key }) => [key, { $value: colors[key] }])),
  })
  return `${JSON.stringify(
    {
      $description: 'Color tokens for the Amagi dashboard.',
      $extensions: { amagi: { name: theme.name, version: 1 } },
      color: {
        light: tokenGroup(theme.variants.light),
        dark: tokenGroup(theme.variants.dark),
      },
    },
    null,
    2,
  )}\n`
}

export function exportBase24Theme(theme: ThemeDefinition, variant: ThemeVariant): string {
  const colors = theme.variants[variant]
  const palette: Record<(typeof BASE16_KEYS)[number] | (typeof BASE24_KEYS)[number], string> = {
    base00: colors.app,
    base01: colors.raised,
    base02: colors['raised-strong'],
    base03: colors['fg-faint'],
    base04: colors['fg-muted'],
    base05: colors.fg,
    base06: colors['fg-strong'],
    base07: colors['fg-strong'],
    base08: colors['red-ink'],
    base09: colors['orange-ink'],
    base0A: colors['amber-ink'],
    base0B: colors['emerald-ink'],
    base0C: colors['cyan-ink'],
    base0D: colors['blue-ink'],
    base0E: colors['violet-ink'],
    base0F: colors['orange-ink'],
    base10: colors.sunken,
    base11: colors.sidebar,
    base12: colors['red-ink'],
    base13: colors['amber-ink'],
    base14: colors['emerald-ink'],
    base15: colors['cyan-ink'],
    base16: colors['blue-ink'],
    base17: colors['violet-ink'],
  }
  const name = theme.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const entries = [...BASE16_KEYS, ...BASE24_KEYS]
    .map((key) => `  ${key}: "${palette[key]}"`)
    .join('\n')
  return `system: "base24"\nname: "${name}"\nauthor: "Amagi"\nvariant: "${variant}"\npalette:\n${entries}\n`
}
