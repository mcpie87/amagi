import { Marked } from 'marked'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Raw HTML from the agent is escaped, not rendered, so a prompt-injected tag cannot run.
const markdown = new Marked({
  // Keep single newlines (soft breaks) as line breaks: the LLM-authored
  // summary/reason text is multi-line and must not flatten into one line.
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

export function Markdown({ text }: { text: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the renderer escapes raw HTML above.
    <div className="summary-markdown" dangerouslySetInnerHTML={{ __html: markdown.parse(text) }} />
  )
}
