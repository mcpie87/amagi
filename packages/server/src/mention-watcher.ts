import {
  type Config,
  type Exec,
  errMsg,
  isAgentMention,
  type MentionProgress,
  type makeHarness,
  mentionsPath,
  type PrComment,
  type PrDriver,
  readHandledMentions,
  respondToMention,
  type Store,
  saveHandledMentions,
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
  /** Event store for durable run, action and classification history. */
  store: Store
  intervalMs?: number
  /** Test seams, forwarded to the mention responder. */
  exec?: Exec | undefined
  makeHarnessFn?: typeof makeHarness | undefined
}

export type MentionWatcher = {
  stop(): void
  activity(): WorkerActivity
}

const DEFAULT_INTERVAL_MS = 300_000

/**
 * Continuously scans open PRs for comments and reviews mentioning the agent
 * handle and responds to each exactly once (comment id dedup). Rate-limit
 * safety comes from the default 5 minute interval.
 *
 * Every open PR is rescanned each tick: the forge's PR `updatedAt` is not a
 * reliable signal that a conversation comment was added (a mention can sit on
 * an "unchanged" PR forever), so there is no per-PR skip. Dedup is by exact
 * comment id through the persisted handled set, so a response happens once
 * per mention regardless of how many scans see it. A failed response is
 * retried next tick, since the mention id is only added to the handled set
 * after a successful reply.
 *
 * Dedup is by exact comment id, never by a numeric watermark:
 * `listComments` mixes issue comments, reviews and inline review comments,
 * which have separate id spaces, so comparing ids numerically would silently
 * drop mentions in a lower-numbered space.
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
  const logEvent = (
    message: string,
    level: 'info' | 'error' = 'info',
    detail: string | null = null,
  ): void => {
    log = [...log, { ts: Date.now(), message, level }].slice(-100)
    activity = { ...activity, log, ...(detail === null ? {} : { detail }) }
  }
  const recordAction = (
    runId: string,
    targetType: 'pr' | 'mention',
    targetId: string,
    prNumber: number,
    result: string,
    level: 'info' | 'error' = 'info',
    url?: string,
  ): void => {
    store.append(null, {
      type: 'watcher.action',
      repo,
      name: 'mention-watcher',
      runId,
      targetType,
      targetId,
      prNumber,
      ...(url === undefined ? {} : { url }),
      result,
      level,
    })
    logEvent(
      `${targetType === 'mention' ? `PR #${prNumber}, mention ${targetId}` : `PR #${prNumber}`}: ${result}`,
      level,
      result,
    )
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

  const { stop } = startPoller(
    intervalMs,
    async () => {
      runs++
      const runId = `${Date.now()}-${runs}`
      const runStartedAt = Date.now()
      store.append(null, { type: 'watcher.run.started', repo, name: 'mention-watcher', runId })
      logEvent(`run ${runs} started`, 'info', 'scanning open PRs')
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
      activity = next
      let scannedNow = 0
      let respondedNow = 0
      try {
        const handledPath = mentionsPath(repoName)
        const handled = readHandledMentions(handledPath)
        const prs = await driver.listOpenPrs(root)
        logEvent(
          `run ${runs}: found ${prs.length} open PR(s)`,
          'info',
          `scanning ${prs.length} open PR(s)`,
        )
        for (const pr of prs) {
          recordAction(
            runId,
            'pr',
            String(pr.number),
            pr.number,
            'reading comments',
            'info',
            pr.url,
          )
          let comments: PrComment[]
          try {
            comments = await driver.listComments(root, pr.number)
          } catch (err) {
            recordAction(
              runId,
              'pr',
              String(pr.number),
              pr.number,
              `failed to read comments: ${errMsg(err)}`,
              'error',
              pr.url,
            )
            console.warn(`mention watch #${pr.number}: ${errMsg(err)}`)
            continue
          }
          scanned++
          scannedNow++
          const mentions = comments.filter(
            (c) => isAgentMention(c, config.forge.agentHandle) && !handled.has(c.id),
          )
          recordAction(
            runId,
            'pr',
            String(pr.number),
            pr.number,
            `scanned ${comments.length} comment(s), found ${mentions.length} new mention(s)`,
            'info',
            pr.url,
          )
          if (mentions.length > 0)
            logEvent(`PR #${pr.number}: found ${mentions.length} new mention(s)`)
          for (const mention of mentions) {
            recordAction(
              runId,
              'mention',
              mention.id,
              pr.number,
              `from @${mention.user}: starting classification`,
              'info',
              pr.url,
            )
            let classifiedKind: string | null = null
            let lastProgressKey = ''
            let lastProgressAt = 0
            try {
              await respondToMention({
                repo,
                root,
                repoName,
                pr,
                mention,
                config,
                driver,
                tracker,
                store,
                exec,
                makeHarnessFn,
                onProgress: (progress: MentionProgress) => {
                  const now = Date.now()
                  const progressKey = `${progress.phase}:${progress.tool ?? ''}`
                  if (progressKey === lastProgressKey && now - lastProgressAt < 10_000) return
                  lastProgressKey = progressKey
                  lastProgressAt = now
                  const timing = `phase ${Math.ceil(progress.phaseMs / 1000)}s, total ${Math.ceil(progress.totalMs / 1000)}s`
                  recordAction(
                    runId,
                    'mention',
                    mention.id,
                    pr.number,
                    `${progress.phase}${progress.tool === null ? '' : `, tool ${progress.tool}`} (${timing})`,
                    'info',
                    pr.url,
                  )
                },
                onClassified: (c) => {
                  classifiedKind = c.kind
                  store.append(null, {
                    type: 'mention.classified',
                    prNumber: pr.number,
                    mentionId: mention.id,
                    ...c,
                  })
                  recordAction(
                    runId,
                    'mention',
                    mention.id,
                    pr.number,
                    `classified as ${c.kind}`,
                    'info',
                    pr.url,
                  )
                },
                onGitBypassed: (entries) => store.append(null, { type: 'git.bypassed', entries }),
              })
              handled.add(mention.id)
              saveHandledMentions(handledPath, handled)
              responded++
              respondedNow++
              const result =
                classifiedKind === 'fix-pr'
                  ? 'fix pushed'
                  : classifiedKind === 'explain'
                    ? 'explanation posted'
                    : classifiedKind === 'add-a-task'
                      ? 'task logged and comment posted'
                      : classifiedKind === 'take-down'
                        ? 'take-down response posted'
                        : classifiedKind === 'ambiguous'
                          ? 'clarification posted'
                          : 'response completed'
              recordAction(runId, 'mention', mention.id, pr.number, result, 'info', pr.url)
            } catch (err) {
              logEvent(`PR #${pr.number}, mention ${mention.id}: ${errMsg(err)}`, 'error')
              recordAction(
                runId,
                'mention',
                mention.id,
                pr.number,
                `${classifiedKind === null ? 'classification or response failed' : `${classifiedKind} failed`}: ${errMsg(err)}`,
                'error',
                pr.url,
              )
              console.warn(`mention watch #${pr.number} ${mention.id}: ${errMsg(err)}`)
            }
          }
        }
        next.detail = `scanned ${scannedNow} PRs, responded to ${respondedNow} mention(s) in ${Math.ceil((Date.now() - runStartedAt) / 1000)}s`
        logEvent(`run ${runs} completed: ${next.detail}`, 'info', next.detail)
      } catch (err) {
        failures++
        next.ok = false
        next.error = errMsg(err)
        next.failures = failures
        next.successes = runs - failures
        next.detail = 'scan failed'
        logEvent(
          `run ${runs} failed after ${Math.ceil((Date.now() - runStartedAt) / 1000)}s: ${next.error}`,
          'error',
          `scan failed after ${Math.ceil((Date.now() - runStartedAt) / 1000)}s`,
        )
        console.warn(`mention watch: ${next.error}`)
      }
      next.counters = counters()
      next.log = log
      activity = next
      try {
        store.append(null, {
          type: 'watcher.run.finished',
          repo,
          name: 'mention-watcher',
          runId,
          ok: next.ok,
          error: next.error,
        })
      } catch (err) {
        console.warn(`mention watcher history: ${errMsg(err)}`)
      }
    },
    true,
  )

  return {
    stop() {
      stop()
      activity = { ...activity, status: 'off', nextRunAt: 0 }
    },
    activity: () => activity,
  }
}
