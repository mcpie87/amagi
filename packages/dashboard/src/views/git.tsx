import { Link, useParams } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { apiBase } from '../api.ts'
import { fmtDateTime } from '../format.ts'
import { gitCommitRoute, gitRoute } from '../routes.tsx'
import { useDashboard } from '../store.tsx'

type CommitSummary = { hash: string; title: string; timestamp: number }
type CommitDetail = CommitSummary & { message: string; patch: string }

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
    return { path, text }
  })
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
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">
            Changed files
          </h2>
          {files.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface p-4 text-sm text-fg-muted">
              This commit has no file changes.
            </p>
          ) : (
            <div className="space-y-3">
              {files.map((file) => (
                <section
                  key={file.path}
                  className="overflow-hidden rounded-lg border border-line bg-surface"
                >
                  <h3 className="border-b border-line px-4 py-2 font-mono text-sm">{file.path}</h3>
                  <pre className="overflow-x-auto p-4 font-mono text-xs leading-5 text-fg">
                    {file.text}
                  </pre>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </GitPageFrame>
  )
}
