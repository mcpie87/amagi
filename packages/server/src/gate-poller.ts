import type { Store, Tracker } from '@amagi/core'

export type GatePollerOptions = {
  store: Store
  tracker: Tracker
  intervalMs?: number
}

export type GatePoller = {
  stop(): void
}

const DEFAULT_INTERVAL_MS = 5_000

/**
 * A human who answers through amagi resolves the gate in the answer handler,
 * but one who closes the gate directly with `bd gate resolve` only shows up
 * as a resolved gate here. Reconciling that out-of-band resolution is what
 * lets answering outside amagi still unblock the waiting agent.
 */
export function startGatePoller({
  store,
  tracker,
  intervalMs = DEFAULT_INTERVAL_MS,
}: GatePollerOptions): GatePoller {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  async function tick(): Promise<void> {
    for (const question of store.openQuestions()) {
      if (question.gateRef === null) continue
      try {
        const resolved = await tracker.gateResolved({
          id: question.gateRef,
          advisory: false,
        })
        if (!resolved) continue
        store.append(question.taskId, {
          type: 'question.answered',
          questionId: question.id,
          answer: '',
          via: 'gate',
        })
        const task = store.task(question.taskId)
        if (task?.state === 'awaiting_answer') {
          store.append(question.taskId, {
            type: 'task.state',
            from: 'awaiting_answer',
            to: 'implementing',
          })
        }
      } catch (err) {
        console.warn(
          `gate poll ${question.id}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }

  timer = setTimeout(() => void tick(), intervalMs)
  return {
    stop() {
      stopped = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
