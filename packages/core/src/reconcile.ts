import type { PrDriver, PrState } from './drivers/pr.ts'
import type { Tracker } from './drivers/types.ts'
import { errMsg } from './errors.ts'
import type { ProjectedTask, Store } from './store/store.ts'

export type ReconcileResult = {
  taskId: string
  to: 'done' | 'abandoned'
}

/**
 * Settles one task parked in pr_open or pr_flagged whose remote PR left the
 * live set: a merged PR finishes the task, a closed one marks it abandoned.
 * The store is updated and the tracker issue is settled too (closed on merge,
 * closed-without-merge) so the bead does not sit in_progress forever, and the
 * PR's branch is deleted from `remote` so a requeued task can reuse it. Returns
 * the settlement when the PR left the live set, else null. Errors resolving
 * the PR are logged and treated as "nothing to do", so the caller never fails.
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
    } catch (err) {
      console.warn(
        `pr reconcile ${task.id}: merge status: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return null
  }
  const to = state === 'merged' ? 'done' : 'abandoned'
  const reason = state === 'merged' ? 'PR merged' : 'PR closed without merge'
  store.append(task.id, { type: 'task.state', from: task.state, to, reason })
  let trackerClosed = false
  try {
    if (to === 'done') {
      await tracker.close(task.id, 'PR merged')
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
 * A merge resolves whatever the operator filed as an error for this task; left
 * open, those `human` beads sit in the queue with nothing left to gate.
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
        await tracker.close(id, `${taskId} merged`)
      }
    } catch (err) {
      console.warn(`pr reconcile ${taskId}: closing error task ${id} failed: ${errMsg(err)}`)
    }
  }
}

/**
 * Settles every task parked in pr_open or pr_flagged whose remote PR left the
 * live set. Errors resolving a single PR are logged and skipped, so one flaky
 * query never stalls the sweep.
 */
export async function reconcilePrs(
  store: Store,
  forge: PrDriver,
  tracker: Tracker,
  cwd: string,
  remote: string,
): Promise<ReconcileResult[]> {
  const moved: ReconcileResult[] = []
  for (const task of store.tasks({ states: ['pr_open', 'pr_flagged'] })) {
    const result = await reconcilePr(store, forge, tracker, cwd, remote, task)
    if (result !== null) moved.push(result)
  }
  return moved
}
