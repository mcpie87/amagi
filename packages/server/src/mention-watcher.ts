import {
  type Config,
  type Exec,
  errMsg,
  isAgentMention,
  listOpenPrs,
  type MentionWatchState,
  type makeHarness,
  mentionsPath,
  mentionWatchPath,
  type PrComment,
  type PrDriver,
  readHandledMentions,
  readMentionWatch,
  respondToMention,
  saveHandledMentions,
  saveMentionWatch,
  type Tracker,
  type WorkerActivity,
} from '@amagi/core'

export type MentionWatcherOptions = {
  /** Repo key, so activity can be attributed across registered repos. */
  repo: string
  root: string
  repoName: string
  config: Config
  driver: PrDriver
  tracker: Tracker
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
 */
export function startMentionWatcher({
  repo,
  root,
  repoName,
  config,
  driver,
  tracker,
  intervalMs = DEFAULT_INTERVAL_MS,
  exec,
  makeHarnessFn,
}: MentionWatcherOptions): MentionWatcher {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Cumulative across ticks, so the dashboard counters keep rising. */
  let scanned = 0
  let responded = 0
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
  }

  async function tick(): Promise<void> {
    const next: WorkerActivity = { ...activity, lastRunAt: Date.now(), ok: true, error: null }
    try {
      const handledPath = mentionsPath(repoName)
      const watchPath = mentionWatchPath(repoName)
      const handled = readHandledMentions(handledPath)
      const prs = await listOpenPrs({ cwd: root, ...(exec === undefined ? {} : { exec }) })
      const state = readMentionWatch(watchPath)
      const nextState: MentionWatchState = {}
      for (const pr of prs) {
        const key = String(pr.number)
        const seen = state[key]
        if (seen !== undefined && seen.updatedAt === pr.updatedAt) {
          nextState[key] = seen
          continue
        }
        let comments: PrComment[]
        try {
          comments = await driver.listComments(root, pr.number)
        } catch (err) {
          console.warn(`mention watch #${pr.number}: ${errMsg(err)}`)
          continue
        }
        scanned++
        const maxId = comments.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0)
        const lastId = seen?.lastCommentId ?? 0
        const mentions = comments.filter(
          (c) =>
            Number(c.id) > lastId &&
            isAgentMention(c, config.forge.agentHandle) &&
            !handled.has(c.id),
        )
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
            })
            handled.add(mention.id)
            saveHandledMentions(handledPath, handled)
            responded++
          } catch (err) {
            allOk = false
            console.warn(`mention watch #${pr.number} ${mention.id}: ${errMsg(err)}`)
          }
        }
        if (allOk) nextState[key] = { updatedAt: pr.updatedAt, lastCommentId: maxId }
      }
      // Dropping closed PRs from the state keeps the file bounded.
      saveMentionWatch(watchPath, nextState)
    } catch (err) {
      next.ok = false
      next.error = errMsg(err)
      console.warn(`mention watch: ${next.error}`)
    }
    next.counters = counters()
    activity = next
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    activity: () => activity,
  }
}
