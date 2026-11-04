import { agentLogKey, agentLogStore } from '@amagi/core/agent-log'
import { errMsg } from '@amagi/core/errors'
import type { ReadyTask, RunnerStatus } from '@amagi/core/run-service'
import { type ProjectedTask, reviewBadge, type Stage } from '@amagi/core/view'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { apiBase } from '../api.ts'
import { Badge, PrStatusChip } from '../badges.tsx'
import { fmtAgo, fmtElapsed, fmtRetryIn } from '../format.ts'
import { tasksRoute } from '../routes.tsx'
import { type RepoInfo, useDashboard, useReadyQueue } from '../store.tsx'
import { EmptyState } from '../ui.tsx'
import { IssueCloseButton } from './issue-close.tsx'
import { IssueFormModal } from './issue-form.tsx'
import type { Issue } from './issue-model.ts'
import { ProposalsInbox } from './proposals.tsx'
import { type BoardCard, type BoardSource, buildBoard, type EpicChip } from './task-board.ts'
import { TaskDetail } from './task-detail.tsx'
import { WorkersPanel } from './workers.tsx'

/** Every repo's tracker and runs are re-read at this cadence; the selected repo's runs also stream. */
const POLL_MS = 5000
/** Done shows this many of its most recent tasks until "show all". */
const DONE_RECENT = 8

const STAGE_ACCENT: Record<Stage, string> = {
  Backlog: 'bg-fg-faint',
  Ready: 'bg-neutral-ink',
  Running: 'bg-blue-ink',
  Review: 'bg-violet-ink',
  'Needs you': 'bg-red-ink',
  'PR open': 'bg-sky-ink',
  Done: 'bg-emerald-ink',
}

/** List order: what needs a human first, finished work last. */
const LIST_ORDER: readonly Stage[] = [
  'Needs you',
  'Running',
  'Review',
  'PR open',
  'Ready',
  'Backlog',
  'Done',
]

const REVIEW_TONE = { ok: 'text-emerald-ink', warn: 'text-amber-ink', active: 'text-violet-ink' }

type TasksSearch = { issue?: string; repo?: string; epic?: string }

/** Sets or clears keys; exactOptionalPropertyTypes rules out writing `undefined` into them. */
function withSearch(
  prev: TasksSearch,
  patch: Partial<Record<keyof TasksSearch, string | undefined>>,
): TasksSearch {
  const next: TasksSearch = { ...prev }
  for (const key of Object.keys(patch) as (keyof TasksSearch)[]) {
    const value = patch[key]
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

type RepoLoad = {
  issues: Issue[]
  ready: ReadyTask[]
  tasks: ProjectedTask[]
  runner: RunnerStatus | null
  eligibleEpics: string[]
}

type Load = { ok: true; data: RepoLoad } | { ok: false; error: string }

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

async function loadRepo(key: string): Promise<RepoLoad> {
  const [issues, ready, tasks, runner, eligible] = await Promise.all([
    getJson<Issue[]>(`/api/repos/${key}/issues`),
    getJson<ReadyTask[]>(`/api/repos/${key}/ready-queue`),
    getJson<ProjectedTask[]>(`/api/repos/${key}/tasks?limit=1000`),
    // Without a runner service the repo still shows its issues, just without worker and seat.
    getJson<RunnerStatus>(`/api/repos/${key}/runner`).catch(() => null),
    // Optional per tracker; without it no epic chip carries the close action.
    getJson<{ id: string }[]>(`/api/repos/${key}/epics/close-eligible`).catch(() => []),
  ])
  return { issues, ready, tasks, runner, eligibleEpics: eligible.map((epic) => epic.id) }
}

/** Every loadable repo's issues, queue, runs and epics, re-read each POLL_MS and on `refresh`. */
function useRepoLoads(repos: RepoInfo[] | null, refresh: number): Record<string, Load> {
  const [loads, setLoads] = useState<Record<string, Load>>({})
  useEffect(() => {
    void refresh
    if (repos === null) return
    // A repo whose config does not load is reported by its readiness checks instead.
    const loadable = repos.filter((repo) =>
      repo.ready.every((check) => check.name !== 'config' || check.ok),
    )
    let active = true
    const load = () => {
      void Promise.all(
        loadable.map(async (repo): Promise<[string, Load]> => {
          try {
            return [repo.key, { ok: true, data: await loadRepo(repo.key) }]
          } catch (err) {
            return [repo.key, { ok: false, error: errMsg(err) }]
          }
        }),
      ).then((entries) => {
        if (active) setLoads(Object.fromEntries(entries))
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [repos, refresh])
  return loads
}

/** The newest non-blank line of a running task's agent log; only the selected repo streams one. */
function LiveActivity({
  repo,
  taskId,
  attempt,
}: {
  repo: string
  taskId: string
  attempt: number
}) {
  const key = agentLogKey(repo, taskId, attempt)
  useSyncExternalStore(
    (listener) => agentLogStore.subscribe(key, listener),
    () => agentLogStore.get(key).version,
  )
  const buffer = agentLogStore.get(key)
  let line: string | undefined
  for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 20; i--) {
    const text = buffer.at(i)?.text.trim()
    if (text) {
      line = text
      break
    }
  }
  if (line === undefined) return null
  return <span className="mt-1 block truncate font-mono text-xs text-fg-faint">{line}</span>
}

function TaskRow({
  card,
  now,
  active,
  live,
  onOpen,
}: {
  card: BoardCard
  now: number
  active: boolean
  live: boolean
  onOpen: () => void
}) {
  const { issue, task, stage, repo, runner } = card
  const review = task === null ? null : reviewBadge(task)
  const worker = [runner?.workerName, runner?.seat]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  const note =
    stage === 'Needs you' && task?.statusReason
      ? {
          text: task.statusReason.startsWith('review ended unresolved (')
            ? `Review stopped${task.statusReason.includes('(tokens)') ? ': token budget exhausted' : ''}; unresolved findings need review`
            : task.statusReason,
          tone: 'text-red-ink',
        }
      : task?.state === 'retrying'
        ? {
            text:
              task.retryAt !== null ? `retries in ${fmtRetryIn(task.retryAt)}` : 'retry pending',
            tone: 'text-orange-ink',
          }
        : stage === 'Ready' && card.claimSkip !== undefined
          ? { text: `${card.claimSkip.state}: ${card.claimSkip.reason}`, tone: 'text-fg-muted' }
          : review !== null
            ? { text: review.text, tone: REVIEW_TONE[review.tone] }
            : worker !== ''
              ? { text: worker, tone: 'text-fg-muted' }
              : null
  return (
    <li
      className={`border-l-2 ${
        active ? 'border-accent bg-raised' : 'border-transparent hover:bg-raised/60'
      }`}
    >
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
        className="block w-full px-3 py-2.5 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span
            aria-hidden
            className={`size-2 shrink-0 self-center rounded-full ${STAGE_ACCENT[stage]}`}
          />
          <span
            className={`min-w-0 flex-1 truncate ${active ? 'font-semibold text-fg-strong' : 'font-medium'}`}
          >
            {issue.title}
          </span>
          {task !== null && (
            <span className="shrink-0 text-xs tabular-nums text-fg-faint">
              {stage === 'Running' ? fmtElapsed(now - task.createdAt) : fmtAgo(task.updatedAt)}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-2 pl-4 text-xs text-fg-faint">
          <span className="max-w-[40%] truncate text-fg-muted">{repo.name}</span>
          <span className="shrink-0">{issue.id}</span>
          {issue.priority !== null && <span className="shrink-0">P{issue.priority}</span>}
          {card.epicTitle !== null && <span className="min-w-0 truncate">{card.epicTitle}</span>}
          {task !== null && (
            <span className="ml-auto shrink-0">
              <Badge state={task.state} />
            </span>
          )}
        </span>
        {note !== null && (
          <span className={`mt-0.5 block truncate pl-4 text-xs ${note.tone}`}>{note.text}</span>
        )}
        {live && stage === 'Running' && task !== null && (
          <span className="block pl-4">
            <LiveActivity repo={repo.key} taskId={issue.id} attempt={task.attempt} />
          </span>
        )}
      </button>
      {task !== null && task.prUrl !== null && (
        <div className="flex flex-wrap items-center gap-2 pb-2 pl-7 pr-3 text-xs">
          <a
            href={task.prUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sky-ink hover:underline"
          >
            PR{task.prNumber === null ? '' : ` #${task.prNumber}`}
          </a>
          {task.checks !== null && task.checksOk !== null && (
            <span className={task.checksOk ? 'text-emerald-ink' : 'text-red-ink'}>
              {task.checksOk ? 'checks passed' : 'checks failed'}
            </span>
          )}
          {task.prMergeStatus !== null && task.prMergeStatus !== 'unknown' && (
            <PrStatusChip status={task.prMergeStatus} />
          )}
          {!repo.watchers && task.state.startsWith('pr_') && (
            <span
              className="text-orange-ink"
              title="The PR poller only runs for repositories with watchers on, so this task stays here after its PR is merged or closed."
            >
              watchers off: merge not tracked
            </span>
          )}
        </div>
      )}
    </li>
  )
}

function EpicChipView({
  epic,
  active,
  onPick,
  onClosed,
}: {
  epic: EpicChip
  active: boolean
  onPick: () => void
  onClosed: () => void
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${
        active ? 'border-accent bg-raised' : 'border-line-strong bg-surface'
      }`}
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={onPick}
        className="flex min-w-0 items-center gap-2 hover:text-sky-ink"
      >
        <span className="max-w-[18rem] truncate font-medium">{epic.title}</span>
        <span className="shrink-0 text-xs tabular-nums text-fg-faint">
          {epic.closed}/{epic.total}
        </span>
      </button>
      {epic.eligible && (
        <IssueCloseButton
          repo={epic.repo.key}
          issue={{ id: epic.id, title: epic.title }}
          action="done"
          onClosed={onClosed}
        />
      )}
    </div>
  )
}

/** Every repo's tasks as a mail-style list grouped by stage, with the selected task in a reading pane. */
export function TasksView() {
  const { repos, selected, selectRepo, state } = useDashboard()
  const readyQueue = useReadyQueue()
  const { issue: openId, repo: repoFilter, epic: epicFilter } = useSearch({ from: tasksRoute.id })
  const navigate = useNavigate()
  const [refresh, setRefresh] = useState(0)
  const loads = useRepoLoads(repos, refresh)
  const [query, setQuery] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  const [stageFilter, setStageFilter] = useState<'All' | Stage>('All')
  const [creating, setCreating] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const refreshAll = () => setRefresh((value) => value + 1)

  const { cards, epics, errors } = useMemo(() => {
    const sources: BoardSource[] = []
    const failures: string[] = []
    for (const repo of repos ?? []) {
      const load = loads[repo.key]
      if (load === undefined) continue
      if (!load.ok) {
        failures.push(`${repo.name}: ${load.error}`)
        continue
      }
      // The selected repo's runs and queue stream live; the other repos are polled.
      const live = repo.key === selected
      sources.push({
        repo: { key: repo.key, name: repo.name, watchers: repo.watchers },
        issues: load.data.issues,
        ready: live ? readyQueue : load.data.ready,
        tasks: live ? Object.values(state.tasks) : load.data.tasks,
        runner: load.data.runner,
        eligibleEpics: load.data.eligibleEpics,
      })
    }
    return { ...buildBoard(sources), errors: failures }
  }, [repos, loads, selected, readyQueue, state.tasks])

  const needle = query.trim().toLowerCase()
  const shown = cards.filter(
    (card) =>
      (repoFilter === undefined || card.repo.key === repoFilter) &&
      (epicFilter === undefined || card.epicId === epicFilter) &&
      (needle === '' ||
        card.issue.title.toLowerCase().includes(needle) ||
        card.issue.id.toLowerCase().includes(needle)),
  )
  const visibleEpics = epics.filter(
    (epic) => repoFilter === undefined || epic.repo.key === repoFilter,
  )
  const byPriority = (a: BoardCard, b: BoardCard) =>
    (a.issue.priority ?? 5) - (b.issue.priority ?? 5)
  const byRecent = (a: BoardCard, b: BoardCard) =>
    (b.task?.updatedAt ?? 0) - (a.task?.updatedAt ?? 0)

  const openCard = (card: BoardCard) => {
    // The run stream belongs to the selected repo, so the panel follows the card's repo.
    if (card.repo.key !== selected) selectRepo(card.repo.key)
    void navigate({
      to: '/tasks',
      search: (prev: TasksSearch) => withSearch(prev, { issue: card.issue.id }),
    })
  }
  const pickEpic = (epic: EpicChip) => {
    const active = epicFilter === epic.id && repoFilter === epic.repo.key
    void navigate({
      to: '/tasks',
      search: (prev: TasksSearch) =>
        withSearch(prev, active ? { epic: undefined } : { repo: epic.repo.key, epic: epic.id }),
      replace: true,
    })
  }

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            className="w-52 rounded border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-strong placeholder:text-fg-faint focus:border-accent"
          />
          {repos !== null && repos.length > 1 && (
            <select
              aria-label="Repository"
              value={repoFilter ?? ''}
              onChange={(e) =>
                void navigate({
                  to: '/tasks',
                  search: (prev: TasksSearch) =>
                    withSearch(prev, {
                      repo: e.target.value === '' ? undefined : e.target.value,
                      epic: undefined,
                    }),
                  replace: true,
                })
              }
              className="rounded border border-line-strong bg-surface px-2 py-1 text-sm"
            >
              <option value="">All repositories</option>
              {repos.map((repo) => (
                <option key={repo.key} value={repo.key}>
                  {repo.name}
                </option>
              ))}
            </select>
          )}
          <span className="text-sm text-fg-faint">
            {shown.length} {shown.length === 1 ? 'task' : 'tasks'}
          </span>
          {selected !== null && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-on-solid hover:bg-accent/90"
            >
              New task
            </button>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <p className="mb-4 text-sm text-red-ink">Could not load tasks: {errors.join('; ')}</p>
      )}
      <ProposalsInbox
        repos={repos ?? []}
        refresh={refresh}
        onChanged={refreshAll}
        selectRepo={selectRepo}
      />
      <WorkersPanel />
      {visibleEpics.length > 0 && (
        <section className="mb-4 flex flex-wrap gap-2" aria-label="Epics">
          {visibleEpics.map((epic) => (
            <EpicChipView
              key={`${epic.repo.key}/${epic.id}`}
              epic={epic}
              active={epicFilter === epic.id && repoFilter === epic.repo.key}
              onPick={() => pickEpic(epic)}
              onClosed={refreshAll}
            />
          ))}
        </section>
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="flex min-w-0 flex-col rounded-lg border border-line-strong bg-surface lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:w-[30rem] lg:shrink-0">
          <div className="flex flex-wrap gap-1 border-b border-line-strong p-2" role="tablist">
            {(['All', ...LIST_ORDER] as const).map((folder) => {
              const count =
                folder === 'All'
                  ? shown.length
                  : shown.filter((card) => card.stage === folder).length
              const current = folder === stageFilter
              return (
                <button
                  key={folder}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  onClick={() => setStageFilter(folder)}
                  className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
                    current
                      ? 'bg-raised font-medium text-fg-strong'
                      : 'text-fg-muted hover:bg-raised'
                  }`}
                >
                  {folder !== 'All' && (
                    <span aria-hidden className={`size-1.5 rounded-full ${STAGE_ACCENT[folder]}`} />
                  )}
                  {folder}
                  <span className="tabular-nums text-fg-faint">{count}</span>
                </button>
              )
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {LIST_ORDER.filter((stage) => stageFilter === 'All' || stageFilter === stage).map(
              (stage) => {
                const inStage = shown
                  .filter((card) => card.stage === stage)
                  .sort(stage === 'Done' ? byRecent : byPriority)
                if (inStage.length === 0) return null
                const listed =
                  stage === 'Done' && !showAllDone ? inStage.slice(0, DONE_RECENT) : inStage
                return (
                  <section key={stage} aria-label={stage}>
                    {stageFilter === 'All' && (
                      <h2 className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-fg-muted">
                        {stage}
                        <span className="tabular-nums font-normal text-fg-faint">
                          {inStage.length}
                        </span>
                      </h2>
                    )}
                    <ul className="divide-y divide-line">
                      {listed.map((card) => (
                        <TaskRow
                          key={`${card.repo.key}/${card.issue.id}`}
                          card={card}
                          now={now}
                          active={card.issue.id === openId && card.repo.key === selected}
                          live={card.repo.key === selected}
                          onOpen={() => openCard(card)}
                        />
                      ))}
                      {stage === 'Done' && inStage.length > DONE_RECENT && (
                        <li>
                          <button
                            type="button"
                            onClick={() => setShowAllDone((value) => !value)}
                            className="w-full px-3 py-2 text-xs text-sky-ink hover:bg-raised"
                          >
                            {showAllDone ? 'Show recent' : `Show all ${inStage.length}`}
                          </button>
                        </li>
                      )}
                    </ul>
                  </section>
                )
              },
            )}
            {shown.filter((card) => stageFilter === 'All' || card.stage === stageFilter).length ===
              0 && <p className="px-3 py-6 text-sm text-fg-faint">Nothing here.</p>}
          </div>
        </div>
        <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface p-4">
          {openId !== undefined && selected !== null ? (
            <>
              <div className="mb-3 flex items-center justify-end gap-3 text-sm">
                <Link
                  to="/tasks/$id"
                  params={{ id: openId }}
                  className="text-sky-ink hover:underline"
                >
                  Open full page
                </Link>
                <button
                  type="button"
                  onClick={() =>
                    void navigate({
                      to: '/tasks',
                      search: (prev: TasksSearch) => withSearch(prev, { issue: undefined }),
                      replace: true,
                    })
                  }
                  className="text-fg-muted hover:text-fg"
                >
                  Close
                </button>
              </div>
              <TaskDetail key={openId} repo={selected} id={openId} onChanged={refreshAll} />
            </>
          ) : (
            <EmptyState icon="runs" title="No task selected">
              Pick a task from the list to see its runs, log and actions.
            </EmptyState>
          )}
        </div>
      </div>
      {creating && selected !== null && (
        <IssueFormModal
          repo={selected}
          mode="create"
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            refreshAll()
          }}
        />
      )}
    </section>
  )
}
