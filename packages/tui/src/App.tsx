import {
  activeTasks,
  type DashboardState,
  fmtBytes,
  fmtCpu,
  isTerminal,
  type ProjectedTask,
  relTime,
  reviewWaitingSeat,
  runHealth,
  runHealthNearLimit,
  type TaskState,
  tasksNeedingAttention,
  watcherRunsFor,
} from '@amagi/core'
import type { TrackerTask } from '@amagi/core/drivers/types'
import type { RunnerStatus } from '@amagi/core/run-service'
import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useMemo, useState } from 'react'
import { TaskDetail } from './TaskDetail.tsx'
import { useDashboardStream } from './useDashboardStream.ts'
import { useOverview } from './useOverview.ts'
import { WatcherDetail } from './WatcherDetail.tsx'

export type AppProps = { baseUrl: string; repo: string }

type Screen =
  | { name: 'overview' }
  | { name: 'queue' }
  | { name: 'detail'; taskId: string }
  | { name: 'watcher'; watcherId: string }

export function App({ baseUrl, repo }: AppProps) {
  const { exit } = useApp()
  const state = useDashboardStream(baseUrl, repo)
  const overview = useOverview(baseUrl, repo)
  const [screen, setScreen] = useState<Screen>({ name: 'overview' })
  const [showAll, setShowAll] = useState(false)
  // One wall-clock snapshot per second so elapsed-vs-budget stays live between
  // stream events.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const tasks = useMemo(
    () =>
      showAll
        ? Object.values(state.tasks).sort((a, b) => b.updatedAt - a.updatedAt)
        : activeTasks(state),
    [state, showAll],
  )

  if (screen.name === 'detail') {
    return (
      <TaskDetail
        baseUrl={baseUrl}
        repo={repo}
        state={state}
        taskId={screen.taskId}
        now={now}
        onBack={() => setScreen({ name: 'queue' })}
      />
    )
  }

  if (screen.name === 'watcher') {
    const watcher = overview.runner?.workers?.find(
      (w) => `${w.repo}/${w.name}` === screen.watcherId,
    )
    const runs = watcher === undefined ? [] : watcherRunsFor(state, watcher.repo, watcher.name, 20)
    return (
      <WatcherDetail
        watcher={watcher ?? null}
        runs={runs}
        onBack={() => setScreen({ name: 'overview' })}
      />
    )
  }

  if (screen.name === 'overview') {
    return (
      <OverviewScreen
        state={state}
        runner={overview.runner}
        ready={overview.ready}
        onSelectWatcher={(watcherId) => setScreen({ name: 'watcher', watcherId })}
        onQueue={() => setScreen({ name: 'queue' })}
        onQuit={() => exit()}
      />
    )
  }

  return (
    <QueueScreen
      tasks={tasks}
      state={state}
      now={now}
      showAll={showAll}
      onToggleAll={() => setShowAll((v) => !v)}
      onSelect={(taskId) => setScreen({ name: 'detail', taskId })}
      onToOverview={() => setScreen({ name: 'overview' })}
      onQuit={() => exit()}
    />
  )
}

function QueueScreen({
  tasks,
  state,
  now,
  showAll,
  onToggleAll,
  onSelect,
  onToOverview,
  onQuit,
}: {
  tasks: ProjectedTask[]
  state: DashboardState
  now: number
  showAll: boolean
  onToggleAll: () => void
  onSelect: (taskId: string) => void
  onToOverview: () => void
  onQuit: () => void
}) {
  const [index, setIndex] = useState(0)
  const selected = Math.min(index, Math.max(tasks.length - 1, 0))

  useInput((input, key) => {
    if (input === 'q' || key.ctrl) {
      if (input === 'q') onQuit()
      return
    }
    if (key.tab || input === 'o') {
      onToOverview()
      return
    }
    if (key.upArrow || input === 'k') setIndex((i) => Math.max(0, i - 1))
    if (key.downArrow || input === 'j') setIndex((i) => Math.min(tasks.length - 1, i + 1))
    if (key.return) {
      const task = tasks[selected]
      if (task) onSelect(task.id)
    }
    if (input === 'a') onToggleAll()
  })

  return (
    <Box flexDirection="column">
      <Text bold>amagi queue {showAll ? '(all)' : '(active)'}</Text>
      {tasks.length === 0 ? (
        <Text dimColor>no {showAll ? '' : 'active '}tasks</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {tasks.map((task, i) => {
            const nearLimit = runHealthNearLimit(runHealth(state, task.id, now))
            const waitingSeat = reviewWaitingSeat(state, task.id)
            return (
              <Box key={task.id} gap={1}>
                {i === selected ? <Text color="cyan">{'>'}</Text> : <Text> </Text>}
                <Badge state={task.state} />
                {waitingSeat !== null && <Text color="yellow">waiting for seat {waitingSeat}</Text>}
                {nearLimit && <Text color="yellow">!</Text>}
                <Text wrap="truncate">{task.title}</Text>
                <Text dimColor>
                  {task.id} {relTime(task.updatedAt)}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>↑/↓ move · enter open · a all/active · tab overview · q quit</Text>
      </Box>
    </Box>
  )
}

function OverviewScreen({
  state,
  runner,
  ready,
  onSelectWatcher,
  onQueue,
  onQuit,
}: {
  state: DashboardState
  runner: RunnerStatus | null
  ready: TrackerTask[]
  onSelectWatcher: (watcherId: string) => void
  onQueue: () => void
  onQuit: () => void
}) {
  const [watcherIndex, setWatcherIndex] = useState(0)
  const watchers = runner?.workers ?? []
  useInput((input, key) => {
    if (key.tab || input === 'o') onQueue()
    else if (input === 'q') onQuit()
    else if (watchers.length > 0 && (key.upArrow || input === 'k')) {
      setWatcherIndex((i) => Math.max(0, i - 1))
    } else if (watchers.length > 0 && (key.downArrow || input === 'j')) {
      setWatcherIndex((i) => Math.min(watchers.length - 1, i + 1))
    } else if (watchers.length > 0 && key.return) {
      const watcher = watchers[watcherIndex]
      if (watcher !== undefined) onSelectWatcher(`${watcher.repo}/${watcher.name}`)
    }
  })

  const running = runner?.running ?? []
  const openPrs = Object.values(state.tasks)
    .filter((t) => t.prUrl !== null && !isTerminal(t.state))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const attention = tasksNeedingAttention(state)
  const resources = running.reduce(
    (acc, id) => {
      const r = runner?.resources[id]
      if (r === undefined) return acc
      return {
        processes: acc.processes + r.processes,
        rssBytes: acc.rssBytes + r.rssBytes,
        cpuMs: acc.cpuMs + r.cpuMs,
      }
    },
    { processes: 0, rssBytes: 0, cpuMs: 0 },
  )

  return (
    <Box flexDirection="column">
      <Text bold>amagi overview</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>runner</Text>
        {runner === null ? (
          <Text dimColor>offline</Text>
        ) : (
          <Text>
            {runner.available ? 'available' : 'busy'} · {runner.busySeats}/{runner.totalSeats} seats
            {' · '}auto-queue {runner.autoQueue ? 'on' : 'off'}
          </Text>
        )}
        {resources.processes > 0 && (
          <Text dimColor>
            rss {fmtBytes(resources.rssBytes)} · cpu {fmtCpu(resources.cpuMs)} · procs{' '}
            {resources.processes}
          </Text>
        )}
      </Box>

      {running.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>running</Text>
          {running.map((id) => {
            const task = state.tasks[id]
            return <Text key={id}>{task !== undefined ? `${task.title} (${id})` : id}</Text>
          })}
        </Box>
      )}

      {runner?.workers !== undefined && runner.workers.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>watchers</Text>
          {watchers.map((w, i) => (
            <Box key={`${w.repo}/${w.name}`} gap={1}>
              <Text {...(i === watcherIndex ? { color: 'cyan' } : {})}>
                {i === watcherIndex ? '>' : ' '}
              </Text>
              <Text {...(w.error !== null ? { color: 'red' } : {})}>
                {w.name} · {w.repo} · last run {w.lastRunAt === 0 ? 'never' : relTime(w.lastRunAt)}
                {w.error === null
                  ? w.detail !== null && w.detail !== undefined
                    ? ` · ${w.detail}`
                    : w.counters.map((c) => ` · ${c.label} ${c.value}`).join('')
                  : ` · ${w.error}`}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text bold>claimable {ready.length > 0 ? `(${ready.length})` : ''}</Text>
        {ready.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          ready.map((t) => (
            <Text key={t.id}>
              {t.id} {t.title}
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>open PRs {openPrs.length > 0 ? `(${openPrs.length})` : ''}</Text>
        {openPrs.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          openPrs.map((t) => (
            <Text key={t.id}>
              {t.prMergeStatus === 'conflicted' ? (
                <Text color="red">conflict</Text>
              ) : t.prMergeStatus === 'mergeable' ? (
                <Text color="green">mergeable</Text>
              ) : (
                <Text color="gray">unknown</Text>
              )}{' '}
              {t.title} ({t.id})
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold {...(attention.length > 0 ? { color: 'yellow' } : {})}>
          needs attention {attention.length > 0 ? `(${attention.length})` : ''}
        </Text>
        {attention.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          attention.map((t) => (
            <Text key={t.id}>
              <Badge state={t.state} /> {t.title} ({t.id})
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {watchers.length > 0 ? '↑/↓ select watcher · enter log · ' : ''}tab queue · q quit
        </Text>
      </Box>
    </Box>
  )
}

function Badge({ state }: { state: TaskState }) {
  const color: Partial<Record<TaskState, string>> = {
    awaiting_answer: 'yellow',
    reviewing: 'magenta',
    fixing: 'blue',
    needs_human: 'red',
    done: 'green',
  }
  return <Text color={color[state] ?? 'gray'}>{state}</Text>
}
