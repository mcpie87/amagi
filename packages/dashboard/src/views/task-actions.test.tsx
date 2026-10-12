import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnswerBox } from './task-actions.tsx'

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
