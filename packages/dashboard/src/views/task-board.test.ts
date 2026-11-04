import { expect, test } from 'bun:test'
import { PROPOSED_LABEL } from '@amagi/core/beads-labels'
import type { ReadyTask } from '@amagi/core/run-service'
import type { ProjectedTask } from '@amagi/core/view'
import type { Issue } from './issue-model.ts'
import { type BoardSource, buildBoard } from './task-board.ts'

const repo = { key: 'repo1', name: 'repo1', watchers: true }

function issue(fields: Pick<Issue, 'id' | 'status'> & Partial<Issue>): Issue {
  return {
    title: fields.id,
    description: '',
    acceptanceCriteria: null,
    priority: 1,
    type: 'task',
    url: null,
    assignee: null,
    labels: [],
    parent: null,
    dependencies: [],
    childCount: 0,
    ...fields,
  }
}

function task(fields: Pick<ProjectedTask, 'id' | 'state'>): ProjectedTask {
  return {
    title: fields.id,
    tracker: 'beads',
    branch: null,
    worktree: null,
    sessionId: null,
    prUrl: null,
    prNumber: null,
    prMergeStatus: null,
    statusReason: null,
    lastError: null,
    retryCount: 0,
    retryAt: null,
    demo: [],
    lastCommit: null,
    checks: null,
    checksOk: null,
    reviewRound: 0,
    reviewFindings: null,
    reviewStopReason: null,
    reviewUnresolved: 0,
    reviewSkipped: null,
    attempt: 1,
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  }
}

function source(fields: Partial<BoardSource>): BoardSource {
  return {
    repo,
    issues: [],
    ready: [],
    tasks: [],
    runner: null,
    eligibleEpics: [],
    ...fields,
  }
}

test('places issues by stage and keeps proposals and epics off the board', () => {
  const ready: ReadyTask[] = [issue({ id: 'am-2', status: 'open', parent: 'am-e' })]
  const { cards, epics } = buildBoard([
    source({
      issues: [
        issue({ id: 'am-e', status: 'open', type: 'epic' }),
        issue({ id: 'am-1', status: 'closed', parent: 'am-e' }),
        issue({ id: 'am-2', status: 'open', parent: 'am-e' }),
        issue({ id: 'am-3', status: 'in_progress' }),
        issue({ id: 'am-p', status: 'open', labels: [PROPOSED_LABEL] }),
      ],
      ready,
      tasks: [task({ id: 'am-3', state: 'implementing' })],
    }),
  ])
  expect(cards.map((card) => [card.issue.id, card.stage])).toEqual([
    ['am-1', 'Done'],
    ['am-2', 'Ready'],
    ['am-3', 'Running'],
  ])
  expect(epics).toEqual([{ repo, id: 'am-e', title: 'am-e', closed: 1, total: 2, eligible: false }])
})

test('epic chips carry eligibility, and cards carry their epic title', () => {
  const { cards, epics } = buildBoard([
    source({
      issues: [
        issue({ id: 'am-e', status: 'open', childCount: 1 }),
        issue({ id: 'am-1', status: 'closed', parent: 'am-e' }),
      ],
      eligibleEpics: ['am-e'],
    }),
  ])
  expect(epics).toEqual([{ repo, id: 'am-e', title: 'am-e', closed: 1, total: 1, eligible: true }])
  expect(cards.map((card) => [card.issue.id, card.epicId, card.epicTitle])).toEqual([
    ['am-1', 'am-e', 'am-e'],
  ])
})
