import { describe, expect, test } from 'bun:test'
import { watchMissingTaskProjection } from './task-projection-recovery.ts'

describe('watchMissingTaskProjection', () => {
  test('resyncs while the task projection is missing, then allows cleanup', () => {
    let tick: (() => void) | undefined
    let cancelled: ReturnType<typeof setInterval> | undefined
    let resyncs = 0
    const timer = setInterval(() => {}, 0)
    clearInterval(timer)

    const cleanup = watchMissingTaskProjection(
      true,
      'repo',
      () => resyncs++,
      (callback, delay) => {
        expect(delay).toBe(4000)
        tick = callback
        return timer
      },
      (handle) => {
        cancelled = handle
      },
    )

    tick?.()
    tick?.()
    expect(resyncs).toBe(2)
    cleanup()
    expect(cancelled).toBe(timer)
  })

  test('does not poll when the task exists or no repository is selected', () => {
    let schedules = 0
    const schedule = () => {
      schedules++
      return setInterval(() => {}, 0)
    }
    const cancel = (timer: ReturnType<typeof setInterval>) => clearInterval(timer)

    watchMissingTaskProjection(false, 'repo', () => {}, schedule, cancel)
    watchMissingTaskProjection(true, null, () => {}, schedule, cancel)
    expect(schedules).toBe(0)
  })
})
