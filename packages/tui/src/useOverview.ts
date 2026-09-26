import type { TrackerTask } from '@amagi/core/drivers/types'
import type { RunnerStatus } from '@amagi/core/run-service'
import { useEffect, useState } from 'react'

export type OverviewData = {
  runner: RunnerStatus | null
  ready: TrackerTask[]
}

const POLL_MS = 4000

/**
 * Live overview data the event stream does not carry: the runner's status
 * (workers, watchers, capacity, resources) and the tracker's unclaimed ready
 * queue. Polled on the same cadence as the web dashboard's providers; every
 * task-level signal (open PRs, run health) already arrives over the stream.
 */
export function useOverview(baseUrl: string, repo: string): OverviewData {
  const [runner, setRunner] = useState<RunnerStatus | null>(null)
  const [ready, setReady] = useState<TrackerTask[]>([])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const [runner, ready] = await Promise.all([
        fetch(`${baseUrl}/api/repos/${repo}/runner`)
          .then((res) => (res.ok ? (res.json() as Promise<RunnerStatus>) : null))
          .catch(() => null),
        fetch(`${baseUrl}/api/repos/${repo}/ready-queue`)
          .then((res) => (res.ok ? (res.json() as Promise<TrackerTask[]>) : []))
          .catch(() => []),
      ])
      if (!alive) return
      setRunner(runner)
      setReady(ready)
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [baseUrl, repo])

  return { runner, ready }
}
