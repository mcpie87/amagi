import { Marked, Renderer } from 'marked'

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

export function Markdown({ text }: { text: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the renderer escapes raw HTML above.
    <div className="summary-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
  )
}
