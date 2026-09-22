import { describe, expect, test } from 'bun:test'
import { canTransition, isTerminal, TASK_STATES } from './events.ts'

describe('state machine', () => {
  test('happy path walks claimed to pr_open, then settles to done', () => {
    const hops = [
      ['claimed', 'worktree_ready'],
      ['worktree_ready', 'implementing'],
      ['implementing', 'checks'],
      ['checks', 'committed'],
      ['committed', 'pr_open'],
    ] as const
    for (const [from, to] of hops) {
      expect(canTransition(from, to)).toBe(true)
    }
    // pr_open is settled to done by the server when the PR merges.
    expect(canTransition('pr_open', 'done')).toBe(true)
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

  test('a parked task whose work was already satisfied can be marked done', () => {
    expect(canTransition('needs_human', 'done')).toBe(true)
    expect(canTransition('no_pr', 'done')).toBe(true)
  })

  test('a stopped run can be retired by instant close', () => {
    expect(canTransition('cancelled', 'abandoned')).toBe(true)
  })

  test('a pointless PR parks in pr_flagged and returns to pr_open when it stops qualifying', () => {
    expect(canTransition('pr_open', 'pr_flagged')).toBe(true)
    expect(canTransition('pr_flagged', 'pr_open')).toBe(true)
    // the merge/close path still settles a flagged task
    expect(canTransition('pr_flagged', 'done')).toBe(true)
    expect(canTransition('pr_flagged', 'abandoned')).toBe(true)
    // non-terminal: the watcher owns the label and clears it back to pr_open
    expect(isTerminal('pr_flagged')).toBe(false)
  })

  test('skipping stages is rejected', () => {
    expect(canTransition('claimed', 'implementing')).toBe(false)
    expect(canTransition('implementing', 'pr_open')).toBe(false)
    expect(canTransition('committed', 'checks')).toBe(false)
  })

  test('self transitions are not transitions', () => {
    expect(canTransition('implementing', 'implementing')).toBe(false)
  })
})
