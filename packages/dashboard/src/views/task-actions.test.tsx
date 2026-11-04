import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerBox, ReclaimButton, ResetButton } from './task-actions.tsx'

test('operator answer controls render without fetching an agent task token', () => {
  const markup = renderToStaticMarkup(
    <AnswerBox
      repo="repo"
      taskId="task"
      question={{
        id: 'question',
        taskId: 'task',
        question: 'Continue?',
        options: ['Continue'],
        askedAt: 0,
        gateRef: null,
        answer: null,
        answeredVia: null,
        resolvedAt: null,
      }}
    />,
  )
  expect(markup).toContain('Continue')
  expect(markup).toContain('Answer')
  expect(markup).not.toContain('unavailable')
})

test('parked tasks can be reclaimed before a worktree exists', () => {
  const markup = renderToStaticMarkup(
    <ReclaimButton repo="enilex" taskId="enilex-5bl" state="needs_human" />,
  )
  expect(markup).toContain('Reclaim')
})

test('completed tasks cannot be reclaimed', () => {
  const markup = renderToStaticMarkup(
    <ReclaimButton repo="enilex" taskId="enilex-5bl" state="done" />,
  )
  expect(markup).not.toContain('Reclaim')
})

test('a parked task without a worktree offers a plain retry', () => {
  const retry = renderToStaticMarkup(
    <ResetButton repo="enilex" taskId="enilex-5bl" state="needs_human" worktree={null} />,
  )
  const reset = renderToStaticMarkup(
    <ResetButton repo="enilex" taskId="enilex-5bl" state="needs_human" worktree="/wt" />,
  )
  expect(retry).toContain('Retry')
  expect(reset).toContain('Reset')
})
