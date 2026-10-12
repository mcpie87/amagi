import { expect, test } from 'bun:test'
import { TASK_STATES } from '@amagi/core/events'
import { KANBAN_COLUMNS } from './board.tsx'

test('every task state except queued has a board column', () => {
  const placed = new Set(KANBAN_COLUMNS.flatMap((column) => column.states ?? []))
  expect(TASK_STATES.filter((state) => state !== 'queued' && !placed.has(state))).toEqual([])
})
