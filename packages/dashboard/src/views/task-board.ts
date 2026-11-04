import { PROPOSED_LABEL } from '@amagi/core/beads-labels'
import type { ReadyTask, RunnerStatus, RunnerTask } from '@amagi/core/run-service'
import { type ProjectedTask, type Stage, taskStage } from '@amagi/core/view'
import type { Issue } from './issue-model.ts'

export type BoardRepo = { key: string; name: string; watchers: boolean }

/** One repository's tracker view and amagi's runs, as the board reads them. */
export type BoardSource = {
  repo: BoardRepo
  issues: Issue[]
  /** The tracker's ready queue, FCFS. */
  ready: ReadyTask[]
  tasks: ProjectedTask[]
  runner: RunnerStatus | null
  /** Ids of the epics the tracker would close now. */
  eligibleEpics: string[]
}

export type BoardCard = {
  repo: BoardRepo
  issue: Issue
  /** amagi's run for the issue; null while it has never been claimed. */
  task: ProjectedTask | null
  stage: Stage
  claimSkip: ReadyTask['claimSkip']
  runner: RunnerTask | undefined
  epicId: string | null
  epicTitle: string | null
}

export type EpicChip = {
  repo: BoardRepo
  id: string
  title: string
  closed: number
  total: number
  eligible: boolean
}

/**
 * Board cards and open epic chips across repositories. Proposals wait in the
 * inbox and epics are never leased, so neither becomes a card. An epic's
 * progress counts its child issues, proposals excluded.
 */
export function buildBoard(sources: BoardSource[]): { cards: BoardCard[]; epics: EpicChip[] } {
  const cards: BoardCard[] = []
  const epics: EpicChip[] = []
  for (const source of sources) {
    const issues = source.issues.filter((issue) => !issue.labels.includes(PROPOSED_LABEL))
    const byId = new Map(issues.map((issue) => [issue.id, issue]))
    const children = new Map<string, Issue[]>()
    for (const issue of issues) {
      if (issue.parent === null) continue
      children.set(issue.parent, [...(children.get(issue.parent) ?? []), issue])
    }
    const tasks = new Map(source.tasks.map((task) => [task.id, task]))
    const ready = new Map(source.ready.map((task) => [task.id, task]))
    for (const issue of issues) {
      if (issue.type === 'epic' || children.has(issue.id)) {
        if (issue.status === 'closed') continue
        const kids = children.get(issue.id) ?? []
        epics.push({
          repo: source.repo,
          id: issue.id,
          title: issue.title,
          closed: kids.filter((kid) => kid.status === 'closed').length,
          total: kids.length,
          eligible: source.eligibleEpics.includes(issue.id),
        })
        continue
      }
      const task = tasks.get(issue.id) ?? null
      const parent = issue.parent === null ? null : (byId.get(issue.parent) ?? null)
      cards.push({
        repo: source.repo,
        issue,
        task,
        stage: taskStage({ status: issue.status, ready: ready.has(issue.id) }, task?.state ?? null),
        claimSkip: ready.get(issue.id)?.claimSkip,
        runner: source.runner?.tasks[issue.id],
        epicId: issue.parent,
        epicTitle: issue.parent === null ? null : (parent?.title ?? issue.parent),
      })
    }
  }
  return { cards, epics }
}
