import { fmtDuration, type watcherRunsFor } from '@amagi/core'
import type { RunnerStatus } from '@amagi/core/run-service'
import { Box, Text, useInput } from 'ink'

export function WatcherDetail({
  watcher,
  runs,
  onBack,
}: {
  watcher: NonNullable<RunnerStatus['workers']>[number] | null
  runs: ReturnType<typeof watcherRunsFor>
  onBack: () => void
}) {
  useInput((input, key) => {
    if (key.escape || key.backspace || input === 'q') onBack()
  })
  return (
    <Box flexDirection="column">
      <Text bold>
        {watcher === null ? 'watcher unavailable' : `${watcher.name} · ${watcher.repo}`}
      </Text>
      {watcher !== null && (
        <>
          <Text dimColor>
            {watcher.status} · {watcher.runs} runs · {watcher.successes} successful ·{' '}
            {watcher.failures} failed
          </Text>
          <Text dimColor>
            next run:{' '}
            {watcher.status === 'off'
              ? 'stopped'
              : watcher.nextRunAt > 0
                ? new Date(watcher.nextRunAt).toLocaleString()
                : 'waiting'}{' '}
            · every {fmtDuration(watcher.intervalMs)}
          </Text>
          {watcher.error !== null && <Text color="red">current error: {watcher.error}</Text>}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>activity log</Text>
            {runs.length === 0 ? (
              <Text dimColor>no activity recorded yet</Text>
            ) : (
              runs
                .flatMap((run) => run.log)
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 40)
                .map((entry, i) => (
                  <Text
                    key={`${entry.ts}-${i}`}
                    {...(entry.level === 'error' ? { color: 'red' } : {})}
                  >
                    {new Date(entry.ts).toLocaleTimeString()} {entry.message}
                  </Text>
                ))
            )}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold>recent runs</Text>
            {runs.length === 0 ? (
              <Text dimColor>no runs recorded yet</Text>
            ) : (
              runs.map((run) => (
                <Box key={run.runId} flexDirection="column" marginTop={1}>
                  <Text color={run.ok === false ? 'red' : 'white'}>
                    {new Date(run.startedAt).toLocaleString()} ·{' '}
                    {run.endedAt === null ? 'running' : run.ok ? 'completed' : 'failed'}
                  </Text>
                  {run.actions.map((action, i) => (
                    <Text
                      key={`${run.runId}-${i}`}
                      {...(action.level === 'error' ? { color: 'red' } : {})}
                    >
                      {action.targetType} {action.targetId}
                      {action.prNumber === undefined ? '' : ` (PR #${action.prNumber})`}:{' '}
                      {action.result}
                    </Text>
                  ))}
                  {run.error !== null && <Text color="red">{run.error}</Text>}
                </Box>
              ))
            )}
          </Box>
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>updates every few seconds · esc back</Text>
      </Box>
    </Box>
  )
}
