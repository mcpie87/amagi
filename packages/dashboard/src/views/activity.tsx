import { fmtTokens } from '@amagi/core/format'
import type { DashboardState } from '@amagi/core/view'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'
import { fmtAgo } from '../format.ts'
import { useDashboard } from '../store.tsx'
import { EmptyState, Icon, type IconName } from '../ui.tsx'

type ActivityItem = {
  key: string
  ts: number
  taskId: string | null
  text: string
  icon: IconName
  tone: 'normal' | 'red' | 'amber' | 'green'
}

/** Fold the event log into a human-readable feed; agent.stream lines are skipped as noise. */
function activityItems(state: DashboardState): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const event of state.events) {
    switch (event.type) {
      case 'task.claimed':
        items.push({
          key: `c${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `claimed "${event.title}"`,
          icon: 'runs',
          tone: 'normal',
        })
        break
      case 'claim.rejected':
        items.push({
          key: `r${event.seq}`,
          ts: event.ts,
          taskId: null,
          text: `claim rejected: ${event.reason}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'task.state':
        items.push({
          key: `s${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `${event.from ?? '?'} → ${event.to}`,
          icon: 'arrow',
          tone: 'normal',
        })
        break
      case 'task.reclaimed':
        items.push({
          key: `tr${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'reclaimed',
          icon: 'refresh',
          tone: 'normal',
        })
        break
      case 'worktree.created':
        items.push({
          key: `w${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `worktree created (${event.branch})`,
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'worktree.removed':
        items.push({
          key: `wr${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'worktree removed',
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'chat.message':
        items.push({
          key: `m${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `chat: ${event.text}`,
          icon: 'agent',
          tone: 'normal',
        })
        break
      case 'agent.started':
        items.push({
          key: `a${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `agent started (${event.harness}${event.model ? `, ${event.model}` : ''}, ${event.role})`,
          icon: 'agent',
          tone: 'normal',
        })
        break
      case 'agent.exited':
        items.push({
          key: `x${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `agent exited (code ${event.exitCode})`,
          icon: 'clock',
          tone: event.exitCode === 0 ? 'green' : 'red',
        })
        break
      case 'checks.finished':
        items.push({
          key: `k${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `checks ${event.ok ? 'passed' : 'failed'} (${event.results.length})`,
          icon: 'check',
          tone: event.ok ? 'green' : 'red',
        })
        break
      case 'commit.created':
        items.push({
          key: `cm${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `commit ${event.sha.slice(0, 7)}`,
          icon: 'branch',
          tone: 'normal',
        })
        break
      case 'pr.created':
        items.push({
          key: `p${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `PR #${event.number} opened`,
          icon: 'external',
          tone: 'green',
        })
        break
      case 'git.blocked':
        items.push({
          key: `gb${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `git write blocked: git ${event.argv.join(' ')}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'git.bypassed':
        items.push({
          key: `gx${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `git write past the shim: ${event.entries.join('; ')}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'question.asked':
        items.push({
          key: `q${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `asked: ${event.question}`,
          icon: 'inbox',
          tone: 'amber',
        })
        break
      case 'question.answered':
        items.push({
          key: `qa${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `answered (${event.via}): ${event.answer}`,
          icon: 'inbox',
          tone: 'green',
        })
        break
      case 'question.timedout':
        items.push({
          key: `qt${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'question timed out',
          icon: 'clock',
          tone: 'red',
        })
        break
      case 'question.parked':
        items.push({
          key: `qp${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: 'question parked',
          icon: 'inbox',
          tone: 'amber',
        })
        break
      case 'retry.scheduled':
        items.push({
          key: `y${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `retry #${event.attempt} in ${(event.delayMs / 1000).toFixed(0)}s`,
          icon: 'refresh',
          tone: 'amber',
        })
        break
      case 'retry.filed_as_error':
        items.push({
          key: `y${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `error filed as task ${event.errorTaskId}`,
          icon: 'refresh',
          tone: 'amber',
        })
        break
      case 'run.restarted':
        items.push({
          key: `rr${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `context restart #${event.restart} (peak ${fmtTokens(event.contextTokens)})`,
          icon: 'refresh',
          tone: 'amber',
        })
        break
      case 'notify.sent':
        items.push({
          key: `n${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `notified via ${event.channel}: ${event.title}`,
          icon: 'activity',
          tone: 'normal',
        })
        break
      case 'error':
        items.push({
          key: `e${event.seq}`,
          ts: event.ts,
          taskId: event.taskId,
          text: `error: ${event.message}`,
          icon: 'close',
          tone: 'red',
        })
        break
      case 'agent.stream':
        break
    }
  }
  return items.reverse().slice(0, 200)
}

const activityTone: Record<ActivityItem['tone'], string> = {
  normal: 'text-fg-muted',
  red: 'text-red-ink',
  amber: 'text-amber-ink',
  green: 'text-emerald-ink',
}

export function ActivityView() {
  const { state } = useDashboard()
  const items = useMemo(() => activityItems(state), [state])
  return (
    <section>
      <div className="mb-5">
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="text-sm text-fg-faint">Everything that happened across runs, newest first.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState icon="activity" title="No activity yet">
          Claims, state changes, checks, commits and pull requests land here as runs progress.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((item) => {
            const inner = (
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <span className={`shrink-0 ${activityTone[item.tone]}`}>
                  <Icon name={item.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {item.text}
                  {item.taskId !== null && (
                    <span className="text-fg-faint">{` · ${item.taskId}`}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-fg-faint">
                  {fmtAgo(item.ts)}
                </span>
              </span>
            )
            return (
              <li key={item.key} className="activity-item px-4 py-2.5 text-sm">
                {item.taskId !== null ? (
                  <Link
                    to="/tasks/$id"
                    params={{ id: item.taskId }}
                    className="flex w-full items-center hover:bg-raised"
                  >
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
