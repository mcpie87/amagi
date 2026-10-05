import { removeWorktree } from './clean.ts'
import { DONE_LABEL, type PrDriver, type PrState, REWORK_LABEL } from './drivers/pr.ts'
import type { PrForge } from './drivers/pr-route.ts'
import type { Tracker } from './drivers/types.ts'
import { errMsg } from './errors.ts'
import type { TaskState } from './events.ts'
import type { ProjectedTask, Store } from './store/store.ts'

/** States a task sits in while its PR is open on the forge. */
export const PR_TASK_STATES: readonly TaskState[] = [
  'pr_open',
  'pr_flagged',
  'pr_merge_conflict',
  'pr_conflict_fixing',
]

export type ReconcileResult = {
  taskId: string
  to: 'done' | 'abandoned' | 'requeued'
}

/**
 * Settles one task parked in pr_open, pr_flagged or pr_merge_conflict whose
 * remote PR left the live set. A merged PR finishes the task. A PR closed
 * unmerged is read through the labels the human closing it attached:
 * DONE_LABEL finishes the task like a merge, REWORK_LABEL starts a fresh
 * attempt, and anything else (neither or both) marks it abandoned.
 * The store is updated and the tracker issue is settled too (closed when done
 * or abandoned, unclaimed when requeued) so the bead does not sit in_progress
 * forever, and the PR's branch is deleted from `remote` so a requeued task can
 * reuse it. Returns the settlement when the PR left the live set, else null.
 * Errors resolving the PR are logged and treated as "nothing to do", so the
 * caller never fails.
 */
export async function reconcilePr(
  store: Store,
  forge: PrDriver,
  tracker: Tracker,
  cwd: string,
  remote: string,
  task: ProjectedTask,
): Promise<ReconcileResult | null> {
  if (task.prNumber === null) return null
  let state: PrState
  try {
    state = await forge.getPr(cwd, task.prNumber)
  } catch (err) {
    console.warn(`pr reconcile ${task.id}: ${errMsg(err)}`)
    return null
  }
  if (state === 'open') {
    try {
      const mergeStatus = await forge.getMergeStatus(cwd, task.prNumber)
      if (task.prMergeStatus !== mergeStatus) {
        store.append(task.id, { type: 'pr.status', mergeStatus })
      }
      if (
        (task.state === 'pr_merge_conflict' || task.state === 'pr_conflict_fixing') &&
        mergeStatus === 'mergeable'
      ) {
        store.append(task.id, {
          type: 'task.state',
          from: task.state,
          to: 'pr_open',
          reason: `PR #${task.prNumber} is no longer conflicted`,
        })
      }
    } catch (err) {
      console.warn(
        `pr reconcile ${task.id}: merge status: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return null
  }
  let labels: string[] = []
  if (state === 'closed') {
    try {
      labels = await forge.getPrLabels(cwd, task.prNumber)
    } catch (err) {
      console.warn(`pr reconcile ${task.id}: labels: ${errMsg(err)}`)
      return null
    }
  }
  const done = labels.includes(DONE_LABEL)
  const rework = labels.includes(REWORK_LABEL)
  if (rework && !done) return requeue(store, forge, tracker, cwd, remote, task)
  const to = state === 'merged' || (done && !rework) ? 'done' : 'abandoned'
  const reason =
    state === 'merged'
      ? 'PR merged'
      : to === 'done'
        ? `PR closed with ${DONE_LABEL}`
        : 'PR closed without merge'
  store.append(task.id, { type: 'task.state', from: task.state, to, reason })
  let trackerClosed = false
  try {
    if (to === 'done') {
      await tracker.close(task.id, reason)
      await closeErrorTasks(store, tracker, task.id)
    } else {
      await tracker.setStatus(task.id, 'closed')
    }
    trackerClosed = true
  } catch (err) {
    console.warn(`pr reconcile ${task.id}: tracker settle failed: ${errMsg(err)}`)
  }
  // A closed PR can still be reopened from its branch, so that branch only goes
  // once the task is closed in the tracker as well; a merge is final either way.
  if (task.branch !== null && (to === 'done' || trackerClosed)) {
    try {
      await forge.deleteBranch(cwd, remote, task.branch)
    } catch (err) {
      console.warn(`pr reconcile ${task.id}: ${errMsg(err)}`)
    }
  }
  return { taskId: task.id, to }
}

/**
 * Starts a fresh attempt for a task whose PR a human closed for rework. The
 * worktree goes first and its failure aborts, so the next tick retries rather
 * than a new run resuming the rejected work.
 */
async function requeue(
  store: Store,
  forge: PrDriver,
  tracker: Tracker,
  cwd: string,
  remote: string,
  task: ProjectedTask,
): Promise<ReconcileResult | null> {
  if (task.worktree !== null) {
    try {
      await removeWorktree(store, task.id, {
        repoRoot: cwd,
        path: task.worktree,
        branch: task.branch,
      })
    } catch (err) {
      console.warn(`pr reconcile ${task.id}: ${errMsg(err)}`)
      return null
    }
  }
  if (task.branch !== null) {
    try {
      await forge.deleteBranch(cwd, remote, task.branch)
    } catch (err) {
      console.warn(`pr reconcile ${task.id}: ${errMsg(err)}`)
    }
  }
  const pr = task.prUrl ?? `#${task.prNumber}`
  store.append(task.id, { type: 'task.reset', reason: `PR ${pr} closed with ${REWORK_LABEL}` })
  try {
    await tracker.comment(task.id, `PR ${pr} was closed for rework; starting a fresh attempt.`)
    await tracker.release(task.id)
  } catch (err) {
    console.warn(`pr reconcile ${task.id}: tracker requeue failed: ${errMsg(err)}`)
  }
  return { taskId: task.id, to: 'requeued' }
}

/**
 * A finished task resolves whatever the operator filed as an error for it;
 * left open, those `human` beads sit in the queue with nothing left to gate.
 */
async function closeErrorTasks(store: Store, tracker: Tracker, taskId: string): Promise<void> {
  const ids = new Set<string>()
  for (const e of store.events({ taskId })) {
    if (e.type === 'retry.filed_as_error') ids.add(e.errorTaskId)
  }
  for (const id of ids) {
    try {
      const errorTask = await tracker.get(id)
      if (errorTask !== null && errorTask.status !== 'closed') {
        await tracker.close(id, `${taskId} done`)
      }
    } catch (err) {
      console.warn(`pr reconcile ${taskId}: closing error task ${id} failed: ${errMsg(err)}`)
    }
  }
}

/**
 * Settles every task parked on an open PR state whose remote PR left the live
 * set, asking the forge `forgeFor` routes each task's PR URL to. Errors
 * resolving a single PR are logged and skipped, so one flaky query never
 * stalls the sweep.
 */
export async function reconcilePrs(
  store: Store,
  forgeFor: (prUrl: string | null) => PrForge,
  tracker: Tracker,
  cwd: string,
): Promise<ReconcileResult[]> {
  const moved: ReconcileResult[] = []
  for (const task of store.tasks({ states: PR_TASK_STATES })) {
    const { driver, config } = forgeFor(task.prUrl)
    const result = await reconcilePr(store, driver, tracker, cwd, config.forge.remote, task)
    if (result !== null) moved.push(result)
  }
  return moved
}
