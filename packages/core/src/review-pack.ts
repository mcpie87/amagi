import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import * as z from 'zod'
import { loadConfig } from './config.ts'
import { FINDING_SEVERITIES, Finding } from './events.ts'
import { repoReviewPackPath, userReviewPackPath } from './paths.ts'

const builtinPackDir = join(import.meta.dir, 'review', 'builtin')

type Lens = { name: string; content: string; matches: string[] }
type ReviewPack = { core: string; lenses: Map<string, Lens> }

export type ReviewPromptOptions = {
  repoRoot: string
  changedFiles: readonly string[]
  roundInstructions: string
  disabledLenses?: readonly string[]
}

function filesIn(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(directory, entry.name))
}

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function frontmatterMatches(content: string, file: string): string[] {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match?.[1]) return []

  const lines = match[1].split(/\r?\n/)
  const start = lines.findIndex((line) => /^match\s*:/.test(line.trim()))
  if (start < 0) return []

  const value = lines[start]?.trim().replace(/^match\s*:\s*/, '') ?? ''
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map(parseScalar).filter(Boolean)
  }
  if (value !== '') return [parseScalar(value)]

  const patterns: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/)
    if (!item?.[1]) break
    patterns.push(parseScalar(item[1]))
  }
  if (patterns.length === 0) {
    throw new Error(`${file}: frontmatter match must contain one or more glob patterns`)
  }
  return patterns
}

function readLens(file: string): Lens {
  const name = basename(file, '.md')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error(
      `${file}: lens filename must use only letters, numbers, dots, underscores, and hyphens`,
    )
  }
  const source = readFileSync(file, 'utf8').trim()
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const content = frontmatter ? source.slice(frontmatter[0].length).trim() : source
  const matches = name === 'base' ? [] : frontmatterMatches(source, file)
  if (name !== 'base' && matches.length === 0) {
    throw new Error(`${file}: non-base lenses require frontmatter with match globs`)
  }
  return { name, content, matches }
}

function resolveReviewPack(repoRoot: string): ReviewPack {
  const coreFiles = [
    join(builtinPackDir, 'review.md'),
    join(userReviewPackPath(), 'review.md'),
    join(repoReviewPackPath(repoRoot), 'review.md'),
  ]
  let core: string | undefined
  for (const file of coreFiles) if (existsSync(file)) core = readFileSync(file, 'utf8').trim()

  const lensFiles = new Map<string, string>()
  const roots = [
    join(builtinPackDir, 'lenses'),
    join(userReviewPackPath(), 'lenses'),
    join(repoReviewPackPath(repoRoot), 'lenses'),
  ]
  for (const root of roots) {
    for (const file of filesIn(root)) {
      lensFiles.set(basename(file, '.md'), file)
    }
  }
  const lenses = new Map(
    [...lensFiles.values()].map((file) => {
      const lens = readLens(file)
      return [lens.name, lens]
    }),
  )
  if (core === undefined)
    throw new Error(`built-in review pack is missing ${join(builtinPackDir, 'review.md')}`)
  if (!lenses.has('base')) throw new Error('review pack must contain lenses/base.md')
  return { core, lenses }
}

function matchesFile(pattern: string, file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  const glob = new Bun.Glob(pattern)
  return glob.match(normalized) || glob.match(basename(normalized))
}

function findingContract(): string {
  const schema = z.toJSONSchema(z.array(Finding))
  const severityList = FINDING_SEVERITIES.map((severity) => `- ${severity}`).join('\n')
  return [
    '## Required findings output',
    '',
    'Return findings as JSON matching this schema. Do not return prose or markdown around the JSON.',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'Severity values, ordered from highest to lowest:',
    severityList,
  ].join('\n')
}

/** Assemble the trusted finding contract after all editable review guidance. */
export function reviewPrompt(options: ReviewPromptOptions): string {
  const pack = resolveReviewPack(options.repoRoot)
  const disabled = new Set(
    options.disabledLenses ?? loadConfig(options.repoRoot).config.review.lenses,
  )
  const changedFiles = options.changedFiles.map((file) => file.replaceAll('\\', '/'))
  const selected = [...pack.lenses.values()]
    .filter((lens) => {
      if (lens.name === 'base') return true
      if (disabled.has(lens.name)) return false
      return lens.matches.some((pattern) => changedFiles.some((file) => matchesFile(pattern, file)))
    })
    .sort((a, b) => (a.name === 'base' ? -1 : b.name === 'base' ? 1 : a.name.localeCompare(b.name)))

  return [
    pack.core,
    ...selected.map((lens) => `## Lens: ${lens.name}\n\n${lens.content}`),
    '## Instructions for this round',
    options.roundInstructions.trim(),
    findingContract(),
  ]
    .filter(Boolean)
    .join('\n\n')
}

function builtinFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...builtinFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export type EjectReviewPackOptions = { repoRoot: string; repo?: boolean; force?: boolean }

/** Copy the shipped review pack into the user or repository config directory. */
export function ejectReviewPack(options: EjectReviewPackOptions): string {
  const target = options.repo ? repoReviewPackPath(options.repoRoot) : userReviewPackPath()
  const files = builtinFiles(builtinPackDir)
  const conflicts = files
    .map((file) => join(target, relative(builtinPackDir, file)))
    .filter((file) => existsSync(file))
  if (conflicts.length > 0 && !options.force) {
    throw new Error(
      `refusing to overwrite existing review pack files; pass --force to replace them:\n${conflicts.join('\n')}`,
    )
  }
  for (const source of files) {
    const destination = join(target, relative(builtinPackDir, source))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  return target
}
