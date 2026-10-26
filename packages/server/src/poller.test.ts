import { afterEach, expect, test } from 'bun:test'
import { startPoller } from './poller.ts'

const pollers: ReturnType<typeof startPoller>[] = []

afterEach(() => {
  for (const poller of pollers.splice(0)) poller.stop()
})

test('re-arms each tick and stops cleanly', async () => {
  let ticks = 0
  pollers.push(
    startPoller(10, async () => {
      ticks++
    }),
  )

  await Bun.sleep(45)
  expect(ticks).toBeGreaterThanOrEqual(3)

  pollers[0]?.stop()
  const after = ticks
  await Bun.sleep(45)
  expect(ticks).toBe(after)
})

test('a slow tick delays the next one instead of overlapping', async () => {
  let running = 0
  let maxRunning = 0
  let ticks = 0
  pollers.push(
    startPoller(10, async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      ticks++
      await Bun.sleep(30)
      running--
    }),
  )

  await Bun.sleep(150)
  expect(maxRunning).toBe(1)
  expect(ticks).toBeGreaterThanOrEqual(2)
})

test('a failing tick is logged and the poller keeps going', async () => {
  let ticks = 0
  pollers.push(
    startPoller(10, async () => {
      ticks++
      throw new Error('tracker down')
    }),
  )

  await Bun.sleep(45)
  expect(ticks).toBeGreaterThanOrEqual(2)
})

test('trigger on an idle poller runs exactly one tick', async () => {
  let ticks = 0
  const poller = startPoller(1_000, async () => {
    ticks++
  })
  pollers.push(poller)

  poller.trigger()
  await Bun.sleep(30)
  expect(ticks).toBe(1)
})
