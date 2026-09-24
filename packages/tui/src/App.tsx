import {
  activeTasks,
  agentLogStore,
  type DashboardState,
  fmtDuration,
  fmtTokens,
  isTerminal,
  openQuestionsFor,
  type ProjectedQuestion,
  type ProjectedTask,
  relTime,
  runHealth,
  runHealthNearLimit,
  type StoredEvent,
  type TaskState,
  tasksNeedingAttention,
} from '@amagi/core'
import type { TrackerTask } from '@amagi/core/drivers/types'
import type { RunnerStatus } from '@amagi/core/run-service'
import { Box, Text, useApp, useInput } from 'ink'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { fetchTaskToken, submitAnswer } from './answer.ts'
import { useDashboardStream } from './useDashboardStream.ts'
import { useOverview } from './useOverview.ts'

const STATE_COLOR: Partial<Record<TaskState, string>> = {
  awaiting_answer: 'yellow',
  needs_human: 'red',
  done: 'green',
}

function Badge({ state }: { state: TaskState }) {
  return <Text color={STATE_COLOR[state] ?? 'gray'}>{state}</Text>
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

function fmtCpu(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

export type AppProps = { baseUrl: string; repo: string }

type Screen = { name: 'overview' } | { name: 'queue' } | { name: 'detail'; taskId: string }

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

  if (screen.name === 'overview') {
    return (
      <OverviewScreen
        state={state}
        runner={overview.runner}
        ready={overview.ready}
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
            return (
              <Box key={task.id} gap={1}>
                {i === selected ? <Text color="cyan">{'>'}</Text> : <Text> </Text>}
                <Badge state={task.state} />
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
  onQueue,
  onQuit,
}: {
  state: DashboardState
  runner: RunnerStatus | null
  ready: TrackerTask[]
  onQueue: () => void
  onQuit: () => void
}) {
  useInput((input, key) => {
    if (key.tab || input === 'o') onQueue()
    else if (input === 'q') onQuit()
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
            {runner.available ? 'available' : 'busy'} · {running.length}/{runner.capacity} workers ·
            auto-queue {runner.autoQueue ? 'on' : 'off'}
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
          {runner.workers.map((w) => (
            <Text key={`${w.repo}/${w.name}`} {...(w.error !== null ? { color: 'red' } : {})}>
              {w.name} · {w.repo} · last run {w.lastRunAt === 0 ? 'never' : relTime(w.lastRunAt)}
              {w.error === null
                ? w.detail !== null && w.detail !== undefined
                  ? ` · ${w.detail}`
                  : w.counters.map((c) => ` · ${c.label} ${c.value}`).join('')
                : ` · ${w.error}`}
            </Text>
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
        <Text dimColor>tab queue · q quit</Text>
      </Box>
    </Box>
  )
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null
  return (
    <Box gap={1}>
      <Box width={10}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  )
}

const AGENT_LOG_TAIL = 12

type AnswerMode =
  | { kind: 'browse' }
  | { kind: 'answering'; questionId: string; draft: string; busy: boolean; error: string | null }

function TaskDetail({
  baseUrl,
  repo,
  state,
  taskId,
  now,
  onBack,
}: {
  baseUrl: string
  repo: string
  state: DashboardState
  taskId: string
  now: number
  onBack: () => void
}) {
  const task = state.tasks[taskId]
  const questions = openQuestionsFor(state, taskId)
  const [qIndex, setQIndex] = useState(0)
  const [mode, setMode] = useState<AnswerMode>({ kind: 'browse' })
  const logKey = `${repo}/${taskId}`
  const health = runHealth(state, taskId, now)

  const version = useSyncExternalStore(
    (listener) => agentLogStore.subscribe(logKey, listener),
    () => agentLogStore.get(logKey).version,
  )
  const tail = useMemo(() => {
    void version
    const buffer = agentLogStore.get(logKey)
    const start = Math.max(0, buffer.length - AGENT_LOG_TAIL)
    const lines = []
    for (let i = start; i < buffer.length; i++) {
      const line = buffer.at(i)
      if (line) lines.push(line)
    }
    return lines
  }, [logKey, version])

  const agentStarts = state.events.filter(
    (e): e is Extract<StoredEvent, { type: 'agent.started' }> =>
      e.taskId === taskId && e.type === 'agent.started',
  )
  const agents = [...new Set(agentStarts.map((e) => `${e.role}: ${e.harness}`))].join(', ')
  const models = [
    ...new Set(agentStarts.map((e) => e.model).filter((m): m is string => m !== null)),
  ].join(', ')
  const efforts = [
    ...new Set(agentStarts.map((e) => e.effort).filter((e): e is string => e !== null)),
  ].join(', ')

  async function answer(questionId: string, text: string): Promise<void> {
    setMode({ kind: 'answering', questionId, draft: text, busy: true, error: null })
    const token = await fetchTaskToken(baseUrl, repo, taskId)
    if (token === null) {
      setMode({
        kind: 'answering',
        questionId,
        draft: text,
        busy: false,
        error: 'could not fetch the task token',
      })
      return
    }
    const outcome = await submitAnswer(baseUrl, repo, taskId, questionId, token, text)
    if (outcome.kind === 'error') {
      setMode({ kind: 'answering', questionId, draft: text, busy: false, error: outcome.message })
    } else {
      setMode({ kind: 'browse' })
    }
  }

  useInput((input, key) => {
    if (mode.kind === 'answering') {
      if (key.escape) {
        setMode({ kind: 'browse' })
        return
      }
      if (key.return) {
        if (mode.draft.trim() !== '' && !mode.busy) void answer(mode.questionId, mode.draft)
        return
      }
      if ((key.backspace || key.delete) && !mode.busy) {
        setMode({ ...mode, draft: mode.draft.slice(0, -1) })
        return
      }
      if (!mode.busy && input !== '' && !key.ctrl && !key.meta) {
        setMode({ ...mode, draft: mode.draft + input })
      }
      return
    }

    if (key.escape || input === 'q') {
      onBack()
      return
    }
    if (questions.length === 0) return
    const selected = Math.min(qIndex, questions.length - 1)
    if (key.upArrow) setQIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) setQIndex((i) => Math.min(questions.length - 1, i + 1))
    if (key.return) {
      const question = questions[selected]
      if (question) {
        setMode({ kind: 'answering', questionId: question.id, draft: '', busy: false, error: null })
      }
    }
    const optionIndex = Number(input) - 1
    const question = questions[selected]
    const option = question?.options[optionIndex]
    if (question && Number.isInteger(optionIndex) && option !== undefined) {
      void answer(question.id, option)
    }
  })

  if (!task) {
    return (
      <Box flexDirection="column">
        <Text dimColor>no events yet for {taskId}</Text>
        <Text dimColor>esc back</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>{task.title}</Text>
        <Badge state={task.state} />
      </Box>
      <Text dimColor>{task.id}</Text>

      <Box flexDirection="column" marginTop={1}>
        <DetailRow label="tracker" value={task.tracker} />
        <DetailRow label="agent" value={agents || null} />
        <DetailRow label="model" value={models || null} />
        <DetailRow label="effort" value={efforts || null} />
        <DetailRow label="worktree" value={task.worktree} />
        <DetailRow label="branch" value={task.branch} />
        <DetailRow label="PR" value={task.prUrl} />
        {task.prMergeStatus !== null && (
          <Box gap={1}>
            <Box width={10}>
              <Text dimColor>pr status</Text>
            </Box>
            <Text
              color={
                task.prMergeStatus === 'conflicted'
                  ? 'red'
                  : task.prMergeStatus === 'mergeable'
                    ? 'green'
                    : 'gray'
              }
            >
              {task.prMergeStatus === 'conflicted' ? 'merge conflict' : task.prMergeStatus}
            </Text>
          </Box>
        )}
        {task.lastCommit !== null && (
          <DetailRow
            label="commit"
            value={`${task.lastCommit.sha.slice(0, 7)} ${task.lastCommit.subject}`}
          />
        )}
        <DetailRow label="session" value={task.sessionId} />
        <DetailRow label="error" value={task.lastError} />
        <DetailRow
          label="context"
          value={
            health.contextTokens === null
              ? null
              : health.contextWarnTokens === null
                ? fmtTokens(health.contextTokens)
                : `${fmtTokens(health.contextTokens)} / ${fmtTokens(health.contextWarnTokens)} warn / ${fmtTokens(health.contextMaxTokens ?? 0)} max`
          }
        />
        <DetailRow
          label="cost"
          value={
            !health.costSeen
              ? null
              : health.maxCostUsd > 0
                ? `$${health.costUsd.toFixed(2)} / $${health.maxCostUsd.toFixed(2)}`
                : `$${health.costUsd.toFixed(2)}`
          }
        />
        <DetailRow
          label="elapsed"
          value={
            health.maxRunMs === null
              ? fmtDuration(health.elapsedMs)
              : `${fmtDuration(health.elapsedMs)} / ${fmtDuration(health.maxRunMs)}`
          }
        />
      </Box>

      {health.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            guard warnings
          </Text>
          {health.warnings.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: warnings are plain strings that may repeat.
            <Text key={i} wrap="truncate">
              {w}
            </Text>
          ))}
        </Box>
      )}

      {tail.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>agent output</Text>
          {tail.map((line) => (
            <Text
              key={line.id}
              dimColor={line.kind === 'reasoning' || line.kind === 'usage'}
              wrap="truncate"
            >
              {line.text === '' ? ' ' : line.text}
            </Text>
          ))}
        </Box>
      )}

      {questions.length > 0 && <QuestionsPanel questions={questions} qIndex={qIndex} mode={mode} />}

      {task.checks !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>checks {task.checksOk ? '(passed)' : '(failed)'}</Text>
          {task.checks.map((c) => (
            <Text key={c.command} color={c.exitCode === 0 ? 'green' : 'red'}>
              exit {c.exitCode} {c.command}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {mode.kind === 'answering'
            ? 'enter submit · esc cancel'
            : questions.length > 0
              ? '↑/↓ select question · enter to type · 1-9 pick option · esc back'
              : 'esc back'}
        </Text>
      </Box>
    </Box>
  )
}

function QuestionsPanel({
  questions,
  qIndex,
  mode,
}: {
  questions: ProjectedQuestion[]
  qIndex: number
  mode: AnswerMode
}) {
  const selected = Math.min(qIndex, questions.length - 1)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="yellow">
        questions
      </Text>
      {questions.map((q, i) => {
        const isSelected = mode.kind === 'browse' && i === selected
        return (
          <Box key={q.id} flexDirection="column">
            {isSelected ? (
              <Text color="cyan">
                {'> '}
                {q.question}
              </Text>
            ) : (
              <Text>
                {'  '}
                {q.question}
              </Text>
            )}
            {q.options.length > 0 && (
              <Text dimColor>
                {'    '}
                {q.options.map((o, oi) => `${oi + 1}:${o}`).join('  ')}
              </Text>
            )}
            {mode.kind === 'answering' && mode.questionId === q.id && (
              <Box gap={1}>
                <Text dimColor>{'    >'}</Text>
                <Text>{mode.draft || ' '}</Text>
                {mode.busy && <Text dimColor>sending…</Text>}
                {mode.error !== null && <Text color="red">{mode.error}</Text>}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
