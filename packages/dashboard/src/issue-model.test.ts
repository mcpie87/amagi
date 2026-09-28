import { describe, expect, test } from 'bun:test'
import { isHumanOnlyIssue } from './views/issue-model.ts'

describe('isHumanOnlyIssue', () => {
  test('includes open human-labeled issues and excludes closed or unlabeled issues', () => {
    expect(isHumanOnlyIssue({ status: 'open', labels: ['human'] })).toBe(true)
    expect(isHumanOnlyIssue({ status: 'in_progress', labels: ['human'] })).toBe(true)
    expect(isHumanOnlyIssue({ status: 'closed', labels: ['human'] })).toBe(false)
    expect(isHumanOnlyIssue({ status: 'open', labels: [] })).toBe(false)
  })
})
