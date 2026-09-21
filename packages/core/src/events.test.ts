import { describe, expect, test } from 'bun:test'
import { canTransition, isTerminal, TASK_STATES } from './events.ts'

describe('state machine', () => {
  test('happy path walks claimed to done', () => {
    const hops = [
      ['claimed', 'worktree_ready'],
      ['worktree_ready', 'implementing'],
      ['implementing', 'checks'],
      ['checks', 'committed'],
      ['committed', 'pr_open'],
      ['pr_open', 'reviewing'],
      ['reviewing', 'done'],
    ] as const
    for (const [from, to] of hops) {
      expect(canTransition(from, to)).toBe(true)
    }
  })

  test('review loop can cycle back through fixing', () => {
    expect(canTransition('reviewing', 'fixing')).toBe(true)
    expect(canTransition('fixing', 'checks')).toBe(true)
    expect(canTransition('fixing', 'reviewing')).toBe(true)
  })

  test('questions park and resume the implementer', () => {
    expect(canTransition('implementing', 'awaiting_answer')).toBe(true)
    expect(canTransition('awaiting_answer', 'implementing')).toBe(true)
  })

  test('a transient failure parks the task in retrying until the retry runs', () => {
    expect(canTransition('implementing', 'retrying')).toBe(true)
    expect(canTransition('retrying', 'implementing')).toBe(true)
  })

  test('any non-terminal state may fall to a terminal state', () => {
    for (const s of TASK_STATES) {
      if (isTerminal(s)) continue
      expect(canTransition(s, 'needs_human')).toBe(true)
      expect(canTransition(s, 'abandoned')).toBe(true)
      expect(canTransition(s, 'cancelled')).toBe(true)
    }
  })

  test('cancelled is terminal and only reclaim can resume it', () => {
    expect(isTerminal('cancelled')).toBe(true)
    expect(canTransition('cancelled', 'claimed')).toBe(false)
    expect(canTransition('cancelled', 'implementing')).toBe(false)
  })

  test('terminal states are absorbing', () => {
    expect(canTransition('done', 'implementing')).toBe(false)
    expect(canTransition('needs_human', 'implementing')).toBe(false)
    expect(canTransition('abandoned', 'claimed')).toBe(false)
  })

  test('a parked needs-attention task can be abandoned by the close action', () => {
    expect(canTransition('needs_human', 'abandoned')).toBe(true)
    expect(canTransition('no_pr', 'abandoned')).toBe(true)
  })

  test('a stopped run can be retired by instant close', () => {
    expect(canTransition('cancelled', 'abandoned')).toBe(true)
  })

  test('skipping stages is rejected', () => {
    expect(canTransition('claimed', 'implementing')).toBe(false)
    expect(canTransition('implementing', 'pr_open')).toBe(false)
    expect(canTransition('committed', 'reviewing')).toBe(false)
  })

  test('self transitions are not transitions', () => {
    expect(canTransition('implementing', 'implementing')).toBe(false)
  })
})
