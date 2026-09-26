import { describe, expect, test } from 'bun:test'
import type { AgentOutcome, AgentProcess } from './drivers/types.ts'
import type { AgentEvent } from './events.ts'
import { openDatabase } from './store/db.ts'
import { Store } from './store/store.ts'
import { recordWatcherAgentRun } from './watcher-agent.ts'

const outcome: AgentOutcome = {
  exitCode: 0,
  ok: true,
  sessionId: 'session-1',
  summary: null,
  usage: null,
  stderr: '',
}

describe('recordWatcherAgentRun', () => {
  test('records usage as a null-task session without retaining watcher output', async () => {
    const store = new Store(openDatabase(':memory:'))
    const stream: AgentEvent[] = [
      { kind: 'text', text: 'watcher response' },
      { kind: 'usage', inputTokens: 12, outputTokens: 4, cachedTokens: 3, costUsd: 0.01 },
    ]
    const proc = {
      pid: 1,
      events: async function* () {
        yield* stream
      },
      done: Promise.resolve(outcome),
      kill: async () => {},
      model: 'model-1',
      effort: 'high',
    } satisfies AgentProcess

    try {
      const result = await recordWatcherAgentRun(
        proc,
        {
          store,
          role: 'triage',
          harness: 'claude',
          source: 'PR #4 mention classification',
          cwd: '/tmp',
        },
        () => {},
      )
      const events = store.events()
      const sessions = events.filter((event) => event.type === 'agent.stream')

      expect(result).toBe(outcome)
      expect(events.map((event) => event.type)).toEqual([
        'agent.started',
        'agent.stream',
        'agent.exited',
      ])
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.taskId).toBeNull()
      expect(store.tasks()).toEqual([])
    } finally {
      store.close()
    }
  })
})
