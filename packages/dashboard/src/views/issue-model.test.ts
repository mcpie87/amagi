import { afterAll, expect, spyOn, test } from 'bun:test'
import { fetchIssue, IssueDetailUnsupported } from './issue-model.ts'

const fetchSpy = spyOn(globalThis, 'fetch')
afterAll(() => fetchSpy.mockRestore())

test('a tracker without issue detail rejects with IssueDetailUnsupported', async () => {
  fetchSpy.mockResolvedValue(
    Response.json({ error: 'issue detail is unavailable' }, { status: 501 }),
  )
  await expect(fetchIssue('repo', 'gh-1')).rejects.toBeInstanceOf(IssueDetailUnsupported)
})

test('other failures stay plain errors carrying the server message', async () => {
  fetchSpy.mockResolvedValue(Response.json({ error: 'unknown issue x' }, { status: 404 }))
  const error = await fetchIssue('repo', 'x').catch((err: unknown) => err)
  expect(error).not.toBeInstanceOf(IssueDetailUnsupported)
  expect((error as Error).message).toBe('unknown issue x')
})
