import hljs from 'highlight.js/lib/core'
import { Marked, Renderer } from 'marked'
import { useSyncExternalStore } from 'react'
import { languageLoaders } from './highlight-languages.ts'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto'])

// Browsers ignore whitespace and control characters inside a scheme, so strip them before reading it.
export const isSafeUrl = (url: string) => {
  const visible = [...url]
    .filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
  const scheme = visible.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]
  return !scheme || ALLOWED_SCHEMES.has(scheme.toLowerCase())
}

const pendingLanguages = new Map<string, Promise<void>>()
const languageListeners = new Set<() => void>()
let languageVersion = 0

// Grammars load on first use, so each one is its own chunk and a reply pays only for the languages it shows.
// The promise always resolves: unknown names are ignored and failed loads are retried on the next call.
export function loadLanguage(name: string): Promise<void> {
  const key = name.toLowerCase()
  const loader = Object.hasOwn(languageLoaders, key) ? languageLoaders[key] : undefined
  if (loader === undefined || hljs.getLanguage(key) !== undefined) return Promise.resolve()
  let pending = pendingLanguages.get(key)
  if (pending === undefined) {
    pending = loader().then(
      ({ default: grammar }) => {
        hljs.registerLanguage(key, grammar)
        languageVersion += 1
        for (const listener of languageListeners) listener()
      },
      () => {
        pendingLanguages.delete(key)
      },
    )
    pendingLanguages.set(key, pending)
  }
  return pending
}

// Raw HTML from the agent is escaped, not rendered, so a prompt-injected tag cannot run.
// Links and images with javascript:, data: or any other non-allowlisted scheme keep their text but lose the URL.
const markdown = new Marked({
  // Keep single newlines (soft breaks) as line breaks: the LLM-authored
  // summary/reason text is multi-line and must not flatten into one line.
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
    code(token) {
      const language = token.lang?.trim().split(/\s+/)[0]?.toLowerCase()
      if (language === undefined || !Object.hasOwn(languageLoaders, language)) {
        return Renderer.prototype.code.call(this, token)
      }
      if (hljs.getLanguage(language) === undefined) {
        loadLanguage(language)
        return Renderer.prototype.code.call(this, token)
      }
      const { value } = hljs.highlight(token.text, { language })
      return `<pre><code class="hljs language-${escapeHtml(language)}">${value}</code></pre>\n`
    },
    link(token) {
      if (!isSafeUrl(token.href)) return this.parser.parseInline(token.tokens)
      return Renderer.prototype.link.call(this, token)
    },
    image(token) {
      if (!isSafeUrl(token.href)) return escapeHtml(token.text)
      return Renderer.prototype.image.call(this, token)
    },
  },
})

export const renderMarkdown = (text: string) => markdown.parse(text)

const subscribeLanguages = (listener: () => void) => {
  languageListeners.add(listener)
  return () => {
    languageListeners.delete(listener)
  }
}

export function Markdown({ text }: { text: string }) {
  // Subscribed so a grammar that finishes loading re-renders this block and highlights it.
  useSyncExternalStore(subscribeLanguages, () => languageVersion)
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the renderer escapes raw HTML above.
    <div className="summary-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  )
}
