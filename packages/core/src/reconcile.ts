import type { PrDriver, PrState } from './drivers/pr.ts'
import type { Tracker } from './drivers/types.ts'
import type { Store } from './store/store.ts'

export type ReconcileResult = {
  taskId: string
  to: 'done' | 'abandoned'
}

/**
 * Settles tasks parked in pr_open whose remote PR left the live set: a merged
 * PR finishes the task, a closed one marks it abandoned. The store is updated
 * and the tracker issue is settled too (closed on merge, closed-without-merge)
 * so the bead does not sit in_progress forever. Errors resolving a single PR
 * are logged and skipped, so one flaky query never stalls the sweep.
 */
export async function reconcilePrs(
  store: Store,
  forge: PrDriver,
  tracker: Tracker,
  cwd: string,
): Promise<ReconcileResult[]> {
  const moved: ReconcileResult[] = []
  for (const task of store.tasks({ states: ['pr_open'] })) {
    if (task.prNumber === null) continue
    let state: PrState
    try {
      state = await forge.getPr(cwd, task.prNumber)
    } catch (err) {
      console.warn(`pr reconcile ${task.id}: ${err instanceof Error ? err.message : String(err)}`)
      continue
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
      continue
    }
    const to = state === 'merged' ? 'done' : 'abandoned'
    const reason = state === 'merged' ? 'PR merged' : 'PR closed without merge'
    store.append(task.id, { type: 'task.state', from: task.state, to, reason })
    try {
      if (to === 'done') {
        await tracker.close(task.id, 'PR merged')
      } else {
        await tracker.setStatus(task.id, 'closed')
      }
    } catch (err) {
      console.warn(
        `pr reconcile ${task.id}: tracker settle failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    moved.push({ taskId: task.id, to })
  }
  return moved
}
