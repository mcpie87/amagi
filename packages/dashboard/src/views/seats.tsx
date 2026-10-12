import { fmtDuration } from '@amagi/core/format'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AgentLogView } from '../AgentLogView.tsx'
import { useDashboard, useSeats } from '../store.tsx'
import { EmptyState, Icon } from '../ui.tsx'
import './seats.css'

export function SeatsView() {
  const seats = useSeats()
  const { selected: selectedRepo, selectRepo, state, repos } = useDashboard()
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)
  const [logScope, setLogScope] = useState<'selected' | 'all'>('selected')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const activeSeat = seats?.find((seat) => seat.seat === selectedSeat) ?? seats?.[0]
  const disabledRepos = repos?.filter((repo) => !repo.workers) ?? []
  const disabledRepoKeys = new Set(disabledRepos.map((repo) => repo.key))
  const activeReady = activeSeat?.eligible.filter((task) => !disabledRepoKeys.has(task.repo)) ?? []
  const activeBlocked = activeSeat?.eligible.filter((task) => disabledRepoKeys.has(task.repo)) ?? []
  const eligible = seats?.flatMap((seat) => seat.eligible) ?? []
  const ready = new Set(
    eligible
      .filter((task) => !disabledRepoKeys.has(task.repo))
      .map((task) => `${task.repo}/${task.taskId}`),
  ).size
  const blocked = new Set(
    eligible
      .filter((task) => disabledRepoKeys.has(task.repo))
      .map((task) => `${task.repo}/${task.taskId}`),
  ).size
  const held = seats?.filter((seat) => seat.state === 'held').length ?? 0
  const waiting = new Set(
    seats?.flatMap((seat) => seat.waiters.map((task) => `${task.repo}/${task.taskId}`)),
  ).size
  const logSeats =
    (logScope === 'all' ? seats : activeSeat ? [activeSeat] : [])?.filter(
      (seat) => seat.holder?.taskId !== undefined,
    ) ?? []
  const elapsed = (since: number | null | undefined) =>
    since === null || since === undefined
      ? 'Time unavailable'
      : fmtDuration(Math.max(0, now - since))

  return (
    <div className="page seats-page">
      <header className="page-header">
        <div>
          <p className="seats-eyebrow seats-page-title">Fleet / credentials</p>
          <h1>Seats</h1>
          <p className="text-xs text-fg-muted">
            Seat usage, queued work, and repository pickup status.
          </p>
        </div>
        <Link to="/settings" className="seats-settings-link">
          <Icon name="settings" size={16} />
          Settings
        </Link>
      </header>
      {disabledRepos.length > 0 && (
        <aside className="seats-repo-notice" aria-label="Repository worker status">
          <Icon name="inbox" size={16} />
          <div>
            <p>
              <strong>Workers disabled</strong>
              <span>
                Automatic task pickup is paused in these repositories. Running agents and watchers
                can still use seats.
              </span>
            </p>
            <div className="seats-disabled-repos">
              {disabledRepos.map((repo) => (
                <Link
                  key={repo.key}
                  to="/settings"
                  search={{ repo: repo.key }}
                  title={`Open settings for ${repo.name}`}
                >
                  {repo.name}
                  <Icon name="external" size={12} />
                </Link>
              ))}
            </div>
          </div>
        </aside>
      )}
      {seats === null ? (
        <EmptyState icon="sessions" title="Seat status unavailable">
          Could not load seat status.
        </EmptyState>
      ) : seats.length === 0 ? (
        <EmptyState icon="sessions" title="No configured seats">
          Configure a worker, watcher, or implement seat to list it here.
        </EmptyState>
      ) : (
        <>
          <section className="seats-overview" aria-label="Seat capacity">
            <div className="seats-capacity">
              <span className="seats-eyebrow">Seat capacity</span>
              <div className="seats-capacity-value">
                <strong>
                  {held}
                  <span className="seats-capacity-total"> / {seats.length}</span>
                </strong>
                <span>in use</span>
              </div>
              <div className="seats-capacity-track" aria-hidden="true">
                {seats.map((seat) => (
                  <span key={seat.seat} data-held={seat.state === 'held'} />
                ))}
              </div>
            </div>
            <dl className="seats-metrics">
              <div>
                <dt>Free</dt>
                <dd className="text-emerald-ink">{seats.length - held}</dd>
              </div>
              <div>
                <dt>
                  <Icon name="clock" size={13} />
                  Waiting
                </dt>
                <dd className={waiting > 0 ? 'text-orange-ink' : 'text-fg-dim'}>{waiting}</dd>
              </div>
              <div>
                <dt>Ready</dt>
                <dd className="text-fg">{ready}</dd>
              </div>
              {blocked > 0 && (
                <div>
                  <dt>Paused</dt>
                  <dd className="text-orange-ink">{blocked}</dd>
                </div>
              )}
            </dl>
          </section>
          <section aria-labelledby="seats-list-heading">
            <div className="seats-section-heading">
              <h2 id="seats-list-heading">
                Credential seats <span>{seats.length}</span>
              </h2>
              <p>Select a seat to inspect its activity</p>
            </div>
            <div className="seats-grid">
              {seats.map((seat) => {
                const blockedCount = seat.eligible.filter((task) =>
                  disabledRepoKeys.has(task.repo),
                ).length
                return (
                  <button
                    key={seat.seat}
                    type="button"
                    aria-pressed={activeSeat?.seat === seat.seat}
                    aria-controls="seat-detail"
                    onClick={() => setSelectedSeat(seat.seat)}
                    className="seat-card"
                    data-held={seat.state === 'held'}
                  >
                    <span className="seat-card-heading">
                      <span className="seat-card-icon">
                        <Icon name="sessions" size={16} />
                      </span>
                      <span className="seat-card-name">{seat.seat}</span>
                      <span
                        className={`seat-state ${seat.state === 'held' ? 'seat-state-held' : 'seat-state-free'}`}
                      >
                        <span className="seats-dot" />
                        {seat.state === 'held' ? 'In use' : 'Available'}
                      </span>
                    </span>
                    <span className="seat-card-work">
                      <span className="seats-eyebrow">
                        {seat.holder === null
                          ? seat.state === 'held'
                            ? 'Holder unknown'
                            : 'Open seat'
                          : seat.holder.repo}
                      </span>
                      <span
                        className={`seat-card-title ${seat.holder === null ? 'text-fg-dim' : 'text-fg-strong'}`}
                      >
                        {seat.holder === null
                          ? seat.state === 'held'
                            ? 'Holder details unavailable'
                            : 'No current holder'
                          : (seat.holder.title ??
                            seat.holder.taskId ??
                            seat.holder.watcher ??
                            'Agent')}
                      </span>
                      {seat.holder !== null && (
                        <span className="seat-card-meta">
                          {seat.holder.taskId && <span>{seat.holder.taskId}</span>}
                          <span>{seat.holder.status ?? 'running'}</span>
                        </span>
                      )}
                    </span>
                    <span className="seat-card-footer">
                      <span>
                        <Icon name="clock" size={13} />
                        {seat.holder === null
                          ? seat.state === 'held'
                            ? 'In use'
                            : 'Idle'
                          : elapsed(seat.holder.since)}
                      </span>
                      <span className={seat.waiters.length > 0 ? 'text-orange-ink' : ''}>
                        {seat.waiters.length} waiting
                      </span>
                      <span>{seat.eligible.length - blockedCount} ready</span>
                      {blockedCount > 0 && (
                        <span className="text-orange-ink">{blockedCount} paused</span>
                      )}
                      <span className="seat-card-arrow">
                        <Icon name="arrow" size={16} />
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
          {activeSeat !== undefined && (
            <section
              id="seat-detail"
              className="seat-detail"
              aria-label={`${activeSeat.seat} activity`}
            >
              <header className="seat-detail-header">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="seat-detail-icon">
                    <Icon name="activity" size={21} />
                  </span>
                  <div className="min-w-0">
                    <p className="seats-eyebrow">Selected seat</p>
                    <h2 className="break-words">{activeSeat.seat}</h2>
                  </div>
                </div>
                <span
                  className={`seat-state ${activeSeat.state === 'held' ? 'seat-state-held' : 'seat-state-free'}`}
                >
                  <span className="seats-dot" />
                  {activeSeat.state === 'held' ? 'In use' : 'Available'}
                </span>
              </header>
              <div className="seat-detail-body">
                <div className="seat-work-panel">
                  <section className="seat-current">
                    <h3 className="seats-eyebrow">Current holder</h3>
                    {activeSeat.holder === null ? (
                      <div className="seat-idle">
                        <Icon name={activeSeat.state === 'held' ? 'agent' : 'check'} size={20} />
                        <div>
                          <p>{activeSeat.state === 'held' ? 'Seat is occupied' : 'Seat is free'}</p>
                          <span className="seat-idle-description">
                            {activeSeat.state === 'held'
                              ? 'Holder details are unavailable.'
                              : 'No agent is using this seat.'}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3">
                        <p className="text-xs text-fg-muted break-all">{activeSeat.holder.repo}</p>
                        {activeSeat.holder.taskId === undefined ? (
                          <p className="seat-holder-title">
                            {activeSeat.holder.watcher ?? 'Agent'}
                          </p>
                        ) : (
                          <Link
                            to="/tasks/$id"
                            params={{ id: activeSeat.holder.taskId }}
                            onClick={() => {
                              if (activeSeat.holder !== null) selectRepo(activeSeat.holder.repo)
                            }}
                            className="seat-holder-title seat-task-link"
                          >
                            {activeSeat.holder.title ?? activeSeat.holder.taskId}
                            <Icon name="external" size={14} />
                          </Link>
                        )}
                        <div className="seat-holder-meta">
                          <span>{activeSeat.holder.status ?? 'running'}</span>
                          <span>
                            <Icon name="clock" size={13} />
                            {elapsed(activeSeat.holder.since)}
                          </span>
                        </div>
                      </div>
                    )}
                  </section>
                  {[
                    { kind: 'waiters', title: 'Waiting for seat', tasks: activeSeat.waiters },
                    { kind: 'eligible', title: 'Ready to start', tasks: activeReady },
                    ...(activeBlocked.length > 0
                      ? [{ kind: 'blocked', title: 'Workers disabled', tasks: activeBlocked }]
                      : []),
                  ].map(({ kind, title, tasks }) => (
                    <section className="seat-queue" key={kind} data-blocked={kind === 'blocked'}>
                      <h3>
                        <Icon name={kind === 'waiters' ? 'clock' : 'runs'} size={15} />
                        {title}
                        <span>{tasks.length}</span>
                      </h3>
                      {tasks.length === 0 ? (
                        <p className="seat-queue-empty">
                          {kind === 'waiters'
                            ? 'Queue clear. No tasks waiting.'
                            : 'No eligible work right now.'}
                        </p>
                      ) : (
                        <ol>
                          {tasks.map((task, index) => (
                            <li key={`${task.repo}/${task.taskId}`}>
                              <span className="seat-queue-position">
                                {(index + 1).toString().padStart(2, '0')}
                              </span>
                              <div className="min-w-0">
                                <Link
                                  to="/tasks/$id"
                                  params={{ id: task.taskId }}
                                  onClick={() => selectRepo(task.repo)}
                                  className="seat-task-link"
                                >
                                  {task.title}
                                </Link>
                                <p className="seat-queue-meta">
                                  <span>
                                    {task.repo} ·{' '}
                                    {kind === 'blocked' ? 'Automatic pickup paused' : task.status}
                                  </span>
                                  <span>
                                    {kind === 'waiters' ? 'Waiting' : 'Age'} {elapsed(task.since)}
                                  </span>
                                </p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  ))}
                </div>
                <div className="seat-output-panel">
                  <div className="seat-output-heading">
                    <h3>
                      <Icon name="agent" size={17} />
                      Live output
                    </h3>
                    <fieldset className="seat-log-switch" aria-label="Log scope">
                      <button
                        type="button"
                        aria-pressed={logScope === 'selected'}
                        onClick={() => setLogScope('selected')}
                      >
                        Selected seat
                      </button>
                      <button
                        type="button"
                        aria-pressed={logScope === 'all'}
                        onClick={() => setLogScope('all')}
                      >
                        All active
                      </button>
                    </fieldset>
                  </div>
                  {logSeats.length === 0 ? (
                    <div className="seat-output-empty">
                      <span className="seat-output-empty-icon">
                        <Icon name="agent" size={30} />
                      </span>
                      <h4>
                        {logScope === 'selected' && activeSeat.holder !== null
                          ? 'No task log for this holder'
                          : 'Quiet for now'}
                      </h4>
                      <p>
                        {logScope === 'selected' && activeSeat.holder !== null
                          ? 'This seat is occupied without a task log to display.'
                          : 'Agent output appears here when a task starts running.'}
                      </p>
                    </div>
                  ) : (
                    logSeats.map(({ seat, holder }) => {
                      if (holder?.taskId === undefined) return null
                      return (
                        <div className="seat-log" key={`${seat}/${holder.repo}/${holder.taskId}`}>
                          <div className="seat-log-label">
                            <span>{seat}</span>
                            <span>
                              {holder.repo} / {holder.taskId}
                            </span>
                          </div>
                          <AgentLogView
                            repo={holder.repo}
                            taskId={holder.taskId}
                            attempt={
                              holder.repo === selectedRepo
                                ? (state.tasks[holder.taskId]?.attempt ?? 1)
                                : 1
                            }
                          />
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
