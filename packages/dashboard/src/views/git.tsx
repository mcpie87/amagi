import { Link, useParams } from '@tanstack/react-router'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { fmtDateTime } from '../format.ts'
import { gitCommitRoute, gitRoute } from '../routes.tsx'
import { useDashboard } from '../store.tsx'

type CommitSummary = { hash: string; title: string; timestamp: number }
type CommitDetail = CommitSummary & { author: string; message: string; patch: string }
type DiffRow = {
  kind: 'added' | 'deleted' | 'context'
  oldLine: number | null
  newLine: number | null
  text: string
}

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)

function useGitData<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (path === null) return
    let active = true
    setData(null)
    setError(null)
    fetch(`${apiBase}${path}`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
        return body as T
      })
      .then((body) => {
        if (active) setData(body)
      })
      .catch((err: unknown) => {
        if (active)
          setError(err instanceof Error ? err.message : 'could not reach the amagi server')
      })
    return () => {
      active = false
    }
  }, [path])
  return { data, error }
}

function GitPageFrame({ children }: { children: React.ReactNode }) {
  const { selected } = useDashboard()
  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-fg-faint">Repository history</p>
          <h1 className="text-2xl font-semibold">Git</h1>
        </div>
        <Link to={gitRoute.to} className="text-sm text-sky-ink hover:underline">
          History
        </Link>
      </div>
      {selected === null ? (
        <p className="text-sm text-fg-muted">Select a repository first.</p>
      ) : (
        children
      )}
    </main>
  )
}

export function GitHistoryView() {
  const { selected } = useDashboard()
  const { data, error } = useGitData<{ commits: CommitSummary[] }>(
    selected === null ? null : `/api/repos/${encodeURIComponent(selected)}/git/log`,
  )
  return (
    <GitPageFrame>
      {error !== null ? <p className="text-sm text-red-ink">{error}</p> : null}
      {data === null && error === null ? (
        <p className="text-sm text-fg-muted">Loading history…</p>
      ) : null}
      {data !== null && data.commits.length === 0 ? (
        <p className="text-sm text-fg-muted">No commits found.</p>
      ) : null}
      <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
        {data?.commits.map((commit) => (
          <li key={commit.hash} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3">
            <Link
              to={gitCommitRoute.to}
              params={{ hash: commit.hash }}
              className="min-w-0 flex-1 truncate text-sm font-medium text-sky-ink hover:underline"
            >
              {commit.title || '(no commit title)'}
            </Link>
            <code className="text-xs text-fg-muted">{commit.hash.slice(0, 12)}</code>
            <time
              className="text-xs text-fg-faint"
              dateTime={new Date(commit.timestamp * 1000).toISOString()}
            >
              {fmtDateTime(commit.timestamp * 1000)}
            </time>
          </li>
        ))}
      </ol>
    </GitPageFrame>
  )
}

function splitFiles(patch: string) {
  const chunks = patch.split(/(?=^diff --git )/m).filter((part) => part.startsWith('diff --git '))
  return chunks.map((text) => {
    const path =
      text.match(/^\+\+\+ b\/(.*)$/m)?.[1] ?? text.match(/^diff --git a\/(.*?) b\//)?.[1] ?? 'file'
    const language = languageForPath(path)
    const hunks = text.split(/^@@ .* @@.*$/m).slice(1)
    const headers = [...text.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/gm)]
    let added = 0
    let deleted = 0
    const parsedHunks = hunks.map((hunk, index) => {
      let oldLine = Number(headers[index]?.[1] ?? 1)
      let newLine = Number(headers[index]?.[2] ?? 1)
      return hunk.split('\n').flatMap<DiffRow>((line) => {
        if (line.startsWith('\\ No newline')) return []
        if (line.startsWith('+')) {
          added += 1
          return [
            { kind: 'added' as const, oldLine: null, newLine: newLine++, text: line.slice(1) },
          ]
        }
        if (line.startsWith('-')) {
          deleted += 1
          return [
            { kind: 'deleted' as const, oldLine: oldLine++, newLine: null, text: line.slice(1) },
          ]
        }
        if (line.startsWith(' ')) {
          return [
            {
              kind: 'context' as const,
              oldLine: oldLine++,
              newLine: newLine++,
              text: line.slice(1),
            },
          ]
        }
        return []
      })
    })
    const sideBySideHunks = parsedHunks.map((rows) => {
      const paired: { left: DiffRow | null; right: DiffRow | null }[] = []
      for (let i = 0; i < rows.length; ) {
        const row = rows[i]
        if (row === undefined) break
        if (row.kind === 'context') {
          paired.push({ left: row, right: row })
          i += 1
          continue
        }
        const deletedRows = []
        const addedRows = []
        while (i < rows.length && rows[i]?.kind === 'deleted') deletedRows.push(rows[i++])
        while (i < rows.length && rows[i]?.kind === 'added') addedRows.push(rows[i++])
        const count = Math.max(deletedRows.length, addedRows.length)
        for (let row = 0; row < count; row += 1) {
          paired.push({ left: deletedRows[row] ?? null, right: addedRows[row] ?? null })
        }
      }
      return paired
    })
    return { path, hunks: parsedHunks, sideBySideHunks, added, deleted, language }
  })
}

function languageForPath(path: string) {
  const extension = path.split('.').at(-1)?.toLowerCase()
  const languages: Record<string, string> = {
    bash: 'bash',
    sh: 'bash',
    css: 'css',
    go: 'go',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rs: 'rust',
    ts: 'typescript',
    tsx: 'typescript',
    html: 'xml',
    svg: 'xml',
    xml: 'xml',
  }
  return extension === undefined ? undefined : languages[extension]
}

function highlightedLine(text: string, language: string | undefined) {
  if (language === undefined || !hljs.getLanguage(language)) return { __html: escapeHtml(text) }
  return { __html: hljs.highlight(text, { language }).value }
}

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function DiffLine({
  row,
  language,
  side,
}: {
  row: DiffRow | null
  language: string | undefined
  side?: 'left' | 'right'
}) {
  const kind = row?.kind ?? 'empty'
  const number = row === null ? '' : side === 'right' ? row.newLine : row.oldLine
  return (
    <div className={`diff-line diff-${kind} grid min-w-max grid-cols-[3.5rem_3.5rem_1fr]`}>
      <span className="select-none border-r border-line px-2 text-right text-fg-faint">
        {side === 'right' && row?.kind === 'context' ? '' : (row?.oldLine ?? '')}
      </span>
      <span className="select-none border-r border-line px-2 text-right text-fg-faint">
        {number ?? ''}
      </span>
      <code
        className="diff-code px-3"
        dangerouslySetInnerHTML={highlightedLine(row?.text ?? '', language)}
      />
    </div>
  )
}

function diffTotals(files: ReturnType<typeof splitFiles>) {
  return {
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  }
}

export function CommitDetailView() {
  const { hash } = useParams({ from: gitCommitRoute.id })
  const { selected } = useDashboard()
  const { data, error } = useGitData<CommitDetail>(
    selected === null
      ? null
      : `/api/repos/${encodeURIComponent(selected)}/git/commits/${encodeURIComponent(hash)}`,
  )
  const files = data === null ? [] : splitFiles(data.patch)
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set())
  const [layout, setLayout] = useState<'stacked' | 'side-by-side'>('stacked')
  const totals = diffTotals(files)
  const allCollapsed = files.length > 0 && files.every((file) => collapsedFiles.has(file.path))
  const toggleFile = (path: string) =>
    setCollapsedFiles((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <GitPageFrame>
      {error !== null ? <p className="text-sm text-red-ink">{error}</p> : null}
      {data === null && error === null ? (
        <p className="text-sm text-fg-muted">Loading commit…</p>
      ) : null}
      {data !== null && (
        <>
          <article className="mb-5 rounded-lg border border-line bg-surface p-5">
            <h2 className="text-xl font-semibold">{data.title || '(no commit title)'}</h2>
            <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-fg-muted">
              <span>{data.author || 'Unknown author'}</span>
              <code>{data.hash}</code>
              <time dateTime={new Date(data.timestamp * 1000).toISOString()}>
                {fmtDateTime(data.timestamp * 1000)}
              </time>
            </div>
            {data.message !== '' && (
              <pre className="mt-4 whitespace-pre-wrap font-sans text-sm text-fg">
                {data.message}
              </pre>
            )}
          </article>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">
              Changed files{' '}
              <span className="normal-case">
                {files.length} files · <span className="text-emerald-ink">+{totals.added}</span> /{' '}
                <span className="text-red-ink">−{totals.deleted}</span>
              </span>
            </h2>
            <div className="flex items-center gap-3 text-xs">
              <button
                type="button"
                className="text-sky-ink hover:underline"
                onClick={() =>
                  setCollapsedFiles(
                    allCollapsed ? new Set() : new Set(files.map((file) => file.path)),
                  )
                }
              >
                {allCollapsed ? 'Expand all' : 'Collapse all'}
              </button>
              <fieldset className="flex items-center gap-2 text-fg-muted">
                <legend className="sr-only">Diff layout</legend>
                {(['stacked', 'side-by-side'] as const).map((option) => (
                  <label key={option} className="flex items-center gap-1">
                    <input
                      type="radio"
                      name="diff-layout"
                      checked={layout === option}
                      onChange={() => setLayout(option)}
                    />
                    {option === 'stacked' ? 'Stacked' : 'Side by side'}
                  </label>
                ))}
              </fieldset>
            </div>
          </div>
          {files.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface p-4 text-sm text-fg-muted">
              This commit has no file changes.
            </p>
          ) : (
            <div className="space-y-3">
              {files.map((file) => (
                <section key={file.path} className="rounded-lg border border-line bg-surface">
                  <h3 className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 font-mono text-sm">
                    <span className="min-w-0 truncate">{file.path}</span>
                    <button
                      type="button"
                      aria-expanded={!collapsedFiles.has(file.path)}
                      className="shrink-0 font-sans text-xs text-sky-ink hover:underline"
                      onClick={() => toggleFile(file.path)}
                    >
                      {collapsedFiles.has(file.path) ? 'Expand' : 'Collapse'}
                    </button>
                  </h3>
                  {!collapsedFiles.has(file.path) && (
                    <div className="overflow-x-auto py-2 font-mono text-xs leading-5 text-fg">
                      {layout === 'stacked'
                        ? file.hunks.map((hunk, hunkIndex) => (
                            <div key={`${file.path}-${hunkIndex}`} className="mb-2 last:mb-0">
                              {hunk.map((row, index) => (
                                <DiffLine
                                  key={`${row.kind}-${row.oldLine}-${row.newLine}-${index}`}
                                  row={row}
                                  language={file.language}
                                />
                              ))}
                            </div>
                          ))
                        : file.sideBySideHunks.map((hunk, hunkIndex) => (
                            <div
                              key={`${file.path}-${hunkIndex}`}
                              className="mb-2 grid min-w-max grid-cols-2 last:mb-0"
                            >
                              <div className="border-r border-line">
                                {hunk.map((pair, index) => (
                                  <DiffLine
                                    key={`left-${index}`}
                                    row={pair.left}
                                    side="left"
                                    language={file.language}
                                  />
                                ))}
                              </div>
                              <div>
                                {hunk.map((pair, index) => (
                                  <DiffLine
                                    key={`right-${index}`}
                                    row={pair.right}
                                    side="right"
                                    language={file.language}
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </GitPageFrame>
  )
}
