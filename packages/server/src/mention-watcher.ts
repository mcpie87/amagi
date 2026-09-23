import {
  type Config,
  type Exec,
  errMsg,
  isAgentMention,
  type MentionWatchState,
  type makeHarness,
  mentionsPath,
  mentionWatchPath,
  type PrComment,
  type PrDriver,
  readHandledMentions,
  readMentionWatch,
  respondToMention,
  type Store,
  saveHandledMentions,
  saveMentionWatch,
  type Tracker,
  type WorkerActivity,
} from '@amagi/core'
import { startPoller } from './poller.ts'

export type MentionWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  root: string
  repoName: string
  config: Config
  driver: PrDriver
  tracker: Tracker
  /** Event store to record classification outcomes, so a misparse is diagnosable later. */
  store?: Store
  intervalMs?: number
  /** Test seams, forwarded to the mention responder. */
  exec?: Exec
  makeHarnessFn?: typeof makeHarness
}

export type MentionWatcher = {
  stop(): void
  activity(): WorkerActivity
}

const DEFAULT_INTERVAL_MS = 300_000

/**
 * Continuously scans open PRs for comments and reviews mentioning the agent
 * handle and responds to each exactly once (comment id dedup). Rate-limit
 * safety comes from two layers: the default 5 minute interval, and per-PR
 * last-seen state that skips fetching comments for PRs whose updatedAt has
 * not changed since the last scan. A PR's state only advances once every
 * mention on it was responded to, so a failed response is retried next tick.
 *
 * Dedup is by exact comment id through the handled set, never by a numeric
 * watermark: `listComments` mixes issue comments, reviews and inline review
 * comments, which have separate id spaces, so comparing ids numerically would
 * silently drop mentions in a lower-numbered space.
 */
export function startMentionWatcher({
  repo,
  root,
  repoName,
  config,
  driver,
  tracker,
  store,
  intervalMs = DEFAULT_INTERVAL_MS,
  exec,
  makeHarnessFn,
}: MentionWatcherOptions): MentionWatcher {
  /** Cumulative across ticks, so the dashboard counters keep rising. */
  let scanned = 0
  let responded = 0
  let runs = 0
  let failures = 0
  let log: NonNullable<WorkerActivity['log']> = []
  const logEvent = (message: string, level: 'info' | 'error' = 'info'): void => {
    log = [...log, { ts: Date.now(), message, level }].slice(-100)
    activity = { ...activity, log }
  }
  const counters = (): WorkerActivity['counters'] => [
    { label: 'scanned', value: scanned },
    { label: 'responded', value: responded },
  ]
  let activity: WorkerActivity = {
    repo,
    name: 'mention-watcher',
    lastRunAt: 0,
    ok: true,
    error: null,
    counters: counters(),
    detail: 'waiting for the first scan',
    runs: 0,
    successes: 0,
    failures: 0,
    nextRunAt: 0,
    intervalMs,
    status: 'idle',
  }

  const { stop } = startPoller(intervalMs, async () => {
    runs++
    logEvent(`run ${runs} started`)
    const next: WorkerActivity = {
      ...activity,
      lastRunAt: Date.now(),
      ok: true,
      error: null,
      runs,
      successes: runs - failures,
      failures,
      nextRunAt: Date.now() + intervalMs,
      intervalMs,
      status: 'active',
    }
    let scannedNow = 0
    let respondedNow = 0
    try {
      const handledPath = mentionsPath(repoName)
      const watchPath = mentionWatchPath(repoName)
      const handled = readHandledMentions(handledPath)
      const prs = await driver.listOpenPrs(root)
      const state = readMentionWatch(watchPath)
      const nextState: MentionWatchState = {}
      for (const pr of prs) {
        const key = String(pr.number)
        const seen = state[key]
        if (seen !== undefined && seen === pr.updatedAt) {
          nextState[key] = seen
          continue
        }
        let comments: PrComment[]
        try {
          comments = await driver.listComments(root, pr.number)
        } catch (err) {
          const message = `PR #${pr.number}: failed to read comments: ${errMsg(err)}`
          logEvent(message, 'error')
          console.warn(`mention watch #${pr.number}: ${errMsg(err)}`)
          continue
        }
        scanned++
        scannedNow++
        const mentions = comments.filter(
          (c) => isAgentMention(c, config.forge.agentHandle) && !handled.has(c.id),
        )
        if (mentions.length > 0)
          logEvent(`PR #${pr.number}: found ${mentions.length} new mention(s)`)
        let allOk = true
        for (const mention of mentions) {
          try {
            await respondToMention({
              root,
              repoName,
              pr,
              mention,
              config,
              driver,
              tracker,
              ...(exec === undefined ? {} : { exec }),
              ...(makeHarnessFn === undefined ? {} : { makeHarnessFn }),
              ...(store === undefined
                ? {}
                : {
                    onClassified: (c) =>
                      store.append(null, {
                        type: 'mention.classified',
                        prNumber: pr.number,
                        mentionId: mention.id,
                        ...c,
                      }),
                  }),
            })
            handled.add(mention.id)
            saveHandledMentions(handledPath, handled)
            responded++
            respondedNow++
          } catch (err) {
            allOk = false
            logEvent(`PR #${pr.number}, mention ${mention.id}: ${errMsg(err)}`, 'error')
            console.warn(`mention watch #${pr.number} ${mention.id}: ${errMsg(err)}`)
          }
        }
        if (allOk) nextState[key] = pr.updatedAt
      }
      // Dropping closed PRs from the state keeps the file bounded.
      saveMentionWatch(watchPath, nextState)
      next.detail = `scanned ${scannedNow} PRs, responded to ${respondedNow} mention(s)`
      logEvent(`run ${runs} completed: ${next.detail}`)
    } catch (err) {
      failures++
      next.ok = false
      next.error = errMsg(err)
      next.failures = failures
      next.successes = runs - failures
      next.detail = 'scan failed'
      logEvent(`run ${runs} failed: ${next.error}`, 'error')
      console.warn(`mention watch: ${next.error}`)
    }
    next.counters = counters()
    next.log = log
    activity = next
  })

  return {
    stop() {
      stop()
      activity = { ...activity, status: 'off', nextRunAt: 0 }
    },
    activity: () => activity,
  }
}
