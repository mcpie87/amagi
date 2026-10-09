import { describe, expect, test } from 'bun:test'
import { isSafeUrl, loadLanguage, renderMarkdown } from './markdown.tsx'

describe('renderMarkdown', () => {
  test('drops javascript:, data: and other non-allowlisted link targets, keeping the text', () => {
    const html = renderMarkdown(
      '[x](javascript:alert(1)) [y](JavaScript:alert(1)) [z](data:text/html,hi)',
    )
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('href="data')
    expect(html).toContain('x')
    expect(html).toContain('z')
  })

  test('drops obfuscated schemes with leading whitespace or embedded control characters', () => {
    const html = renderMarkdown('[a](  javascript:alert(1)) [b](java\tscript:alert(1))')
    expect(html).not.toContain('javascript')
  })

  test('drops autolinks with unsafe schemes', () => {
    const html = renderMarkdown('<javascript:alert(1)> and <data:text/html,hi>')
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('href="data')
  })

  test('drops image sources with unsafe schemes and keeps the alt text', () => {
    const html = renderMarkdown(
      '![alt text](javascript:alert(1)) ![pic](data:image/png;base64,AAAA)',
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('javascript')
    expect(html).not.toContain('data:')
    expect(html).toContain('alt text')
  })

  test('keeps http, https, mailto and relative links unchanged', () => {
    expect(renderMarkdown('[a](https://example.com/x?y=1)')).toBe(
      '<p><a href="https://example.com/x?y=1">a</a></p>\n',
    )
    expect(renderMarkdown('[m](mailto:someone@example.com)')).toBe(
      '<p><a href="mailto:someone@example.com">m</a></p>\n',
    )
    expect(renderMarkdown('[r](docs/readme.md)')).toBe('<p><a href="docs/readme.md">r</a></p>\n')
    expect(renderMarkdown('![i](https://example.com/a.png)')).toContain(
      'src="https://example.com/a.png"',
    )
  })

  test('still escapes raw HTML', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img')
  })

  test('highlights fenced code once its language has loaded, and escapes its content', async () => {
    await loadLanguage('ts')
    const html = renderMarkdown('```ts\nconst a = "<b>"\n```')
    expect(html).toContain('<span class="hljs-keyword">const</span>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })

  test('leaves fenced code in an unknown language unhighlighted', () => {
    expect(renderMarkdown('```nope\nx < y\n```')).toBe(
      '<pre><code class="language-nope">x &lt; y\n</code></pre>\n',
    )
    expect(renderMarkdown('```constructor\nx\n```')).toBe(
      '<pre><code class="language-constructor">x\n</code></pre>\n',
    )
  })
})

describe('isSafeUrl', () => {
  test('allows only http, https, mailto and scheme-less urls', () => {
    expect(isSafeUrl('https://a.b')).toBe(true)
    expect(isSafeUrl('HTTP://a.b')).toBe(true)
    expect(isSafeUrl('mailto:a@b.c')).toBe(true)
    expect(isSafeUrl('/relative/path')).toBe(true)
    expect(isSafeUrl('#anchor')).toBe(true)
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('data:text/html,x')).toBe(false)
    expect(isSafeUrl('vbscript:x')).toBe(false)
  })
})
