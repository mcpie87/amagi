import { existsSync } from 'node:fs'
import type { Config } from './config.ts'
import { forgeToken, gitTokenConfig } from './drivers/forge-cred.ts'
import { amagiLabels, type PrDriver } from './drivers/pr.ts'
import { assertSafePushDestination } from './drivers/push-safety.ts'
import type { Tracker, TrackerTask } from './drivers/types.ts'
import { errMsg } from './errors.ts'
import { canChatTask, type EventBody } from './events.ts'
import { type Exec, execOk } from './exec.ts'
import { changesSinceBase, formatPrBody } from './pr-body.ts'
import type { ProjectedTask } from './project.ts'
import { prTitle } from './prompt.ts'
import type { Store } from './store/store.ts'
import { applyRepoIdentity, createWorktree } from './worktree.ts'

export type TaskChatDeps = {
  store: Store
  tracker: Tracker
  config: Config
  repoRoot: string
  repoName: string
  exec: Exec
}

export type TaskChatHold =
  | { ok: true; task: TrackerTask; cwd: string; branch: string; prUrl: string | null }
  | { ok: false; status: 404 | 409; error: string }

/** The verbs that leave the machine, so the operator approves each one in the chat. */
export type ApprovalVerb = Extract<EventBody, { type: 'git.request' }>['verb']

/**
 * Gives the operator's chat agent a worktree on `taskId` and keeps workers and
 * watchers off it. An unrun or parked task is claimed in the tracker and held
 * in `chatting`, which no stall watcher, lease reaper or worker touches; a
 * conflicted PR is held the same way so the conflict watcher leaves it to the
 * chat; an open PR is chatted on where it is. The recorded worktree is reused
 * whenever it is still on disk.
 */
export async function holdTaskForChat(deps: TaskChatDeps, taskId: string): Promise<TaskChatHold> {
  const { store, tracker, config } = deps
  const recorded = store.task(taskId)
  const state = recorded?.state ?? null
  if (!canChatTask(state)) {
    return {
      ok: false,
      status: 409,
      error: `task ${taskId} is ${state}, which a chat cannot take over`,
    }
  }
  const issue = await tracker.get(taskId)
  if (issue === null) return { ok: false, status: 404, error: `unknown task ${taskId}` }
  if (issue.status === 'closed') {
    return { ok: false, status: 409, error: `task ${taskId} is closed` }
  }
  const onDisk =
    recorded !== null &&
    recorded.worktree !== null &&
    recorded.branch !== null &&
    existsSync(recorded.worktree)
      ? { path: recorded.worktree, branch: recorded.branch }
      : null
  const held = (path: string, branch: string): TaskChatHold => ({
    ok: true,
    task: issue,
    cwd: path,
    branch,
    prUrl: store.task(taskId)?.prUrl ?? null,
  })

  if (state === 'chatting' || state === 'pr_open' || state === 'pr_flagged') {
    if (onDisk === null) {
      return { ok: false, status: 409, error: `task ${taskId} has no worktree left on disk` }
    }
    return held(onDisk.path, onDisk.branch)
  }
  if (state === 'pr_merge_conflict') {
    if (onDisk === null) {
      return { ok: false, status: 409, error: `task ${taskId} has no worktree left on disk` }
    }
    store.append(taskId, {
      type: 'task.state',
      from: state,
      to: 'chatting',
      reason: 'held by the operator chat to resolve the conflicts',
    })
    return held(onDisk.path, onDisk.branch)
  }

  // Unrun or parked: a parked run may still hold its claim, an unrun one held
  // by somebody else is not ours to take.
  if (recorded !== null) {
    try {
      await tracker.release(taskId)
    } catch (err) {
      console.warn(`release ${taskId} for chat: ${errMsg(err)}`)
    }
  } else if (issue.status === 'in_progress') {
    return { ok: false, status: 409, error: `task ${taskId} is claimed in the tracker` }
  }
  const claimed = await tracker.claim(taskId)
  if (claimed === null) return { ok: false, status: 409, error: `could not claim ${taskId}` }
  store.append(taskId, {
    type: 'task.claimed',
    title: claimed.title,
    tracker: tracker.kind,
    description: claimed.description,
    priority: claimed.priority,
    taskType: claimed.type,
    url: claimed.url,
  })
  let worktree = onDisk
  if (worktree === null) {
    const tokenCfg = await gitTokenConfig(
      deps.exec,
      deps.repoRoot,
      config.forge.remote,
      forgeToken(config.forge.kind, deps.repoRoot),
    )
    // Without a token the local base branch is used so git never prompts.
    const fetched = Object.keys(tokenCfg).length > 0
    if (fetched) {
      await execOk(deps.exec, ['git', 'fetch', config.forge.remote, config.repo.baseBranch], {
        cwd: deps.repoRoot,
        env: tokenCfg,
      })
    }
    worktree = await createWorktree({
      repoRoot: deps.repoRoot,
      repoName: deps.repoName,
      taskId,
      title: claimed.title,
      baseBranch: fetched
        ? `${config.forge.remote}/${config.repo.baseBranch}`
        : config.repo.baseBranch,
      worktreeRoot: config.repo.worktreeRoot,
      setupCmd: config.repo.setupCmd,
      persona: config.repo.persona,
      exec: deps.exec,
      onSetupStarted: (command) => store.append(taskId, { type: 'setup.started', command }),
      onSetupFinished: (report) => store.append(taskId, { type: 'setup.finished', ...report }),
    })
  } else {
    await applyRepoIdentity(deps.exec, worktree.path, deps.repoRoot, config.repo.persona)
  }
  store.append(taskId, { type: 'worktree.created', path: worktree.path, branch: worktree.branch })
  store.append(taskId, {
    type: 'task.state',
    from: 'claimed',
    to: 'chatting',
    reason: 'held by the operator chat',
  })
  return held(worktree.path, worktree.branch)
}

/**
 * Merges the remote base branch into the task worktree for a chat agent. A
 * conflicted merge is left in place for the agent to resolve and commit.
 */
export async function mergeBaseForChat(
  deps: Pick<TaskChatDeps, 'config' | 'exec' | 'repoRoot'>,
  cwd: string,
): Promise<string> {
  const { config, exec } = deps
  const auth = await gitTokenConfig(
    exec,
    cwd,
    config.forge.remote,
    forgeToken(config.forge.kind, deps.repoRoot),
  )
  await execOk(exec, ['git', 'fetch', config.forge.remote, config.repo.baseBranch], {
    cwd,
    env: auth,
  })
  const base = `${config.forge.remote}/${config.repo.baseBranch}`
  const merged = await exec(['git', 'merge', '--no-edit', base], { cwd })
  if (merged.exitCode === 0) return `merged ${base}: ${merged.stdout.trim() || 'done'}`
  const conflicted = await exec(['git', 'diff', '--name-only', '--diff-filter=U'], { cwd })
  const files = conflicted.stdout.trim()
  if (files === '') throw new Error(`git merge ${base} failed: ${merged.stderr.trim()}`)
  return `merging ${base} stopped on conflicts; resolve these files, then request a commit:\n${files}`
}

/**
 * Carries out an outward-facing git request the operator approved and returns
 * what happened, worded for the agent. Throws when it cannot be done.
 */
export async function runApprovedGitRequest(
  deps: TaskChatDeps & { forge: PrDriver | null },
  task: ProjectedTask,
  verb: ApprovalVerb,
  message: string | undefined,
): Promise<string> {
  const { store, tracker, config, exec } = deps
  if (verb === 'close') {
    await tracker.close(task.id, message)
    store.append(task.id, {
      type: 'task.state',
      from: task.state,
      to: 'done',
      reason: message ?? 'closed from the operator chat',
    })
    return `closed ${task.id}`
  }
  if (verb === 'comment') {
    const body = message?.trim()
    if (!body) throw new Error('a comment needs --message')
    if (task.prNumber !== null && deps.forge !== null && task.worktree !== null) {
      await deps.forge.postComment(task.worktree, task.prNumber, body)
      return `commented on PR #${task.prNumber}`
    }
    await tracker.comment(task.id, body)
    return `commented on ${task.id}`
  }
  if (task.worktree === null || task.branch === null) {
    throw new Error(`task ${task.id} has no worktree to push`)
  }
  if (deps.forge === null) throw new Error('no forge is configured for this repository')
  const cwd = task.worktree
  if (task.prNumber !== null) {
    const auth = await gitTokenConfig(
      exec,
      cwd,
      config.forge.remote,
      forgeToken(config.forge.kind, deps.repoRoot),
    )
    await assertSafePushDestination(exec, cwd, config.forge.remote, task.branch, auth)
    await execOk(exec, ['git', 'push', config.forge.remote, task.branch], { cwd, env: auth })
    if (task.state === 'chatting') {
      store.append(task.id, {
        type: 'task.state',
        from: 'chatting',
        to: 'pr_open',
        reason: `pushed to PR #${task.prNumber} from the operator chat`,
      })
    }
    return `pushed ${task.branch} to PR #${task.prNumber} (${task.prUrl ?? 'no url recorded'})`
  }
  if (verb === 'push') throw new Error(`task ${task.id} has no pull request yet; request pr`)
  const issue = await tracker.get(task.id)
  if (issue === null) throw new Error(`unknown task ${task.id}`)
  const changes = await changesSinceBase(exec, cwd, config.forge.remote, config.repo.baseBranch)
  if (changes.length === 0) throw new Error('the branch has no changes against the base')
  const pr = await deps.forge.createPr({
    cwd,
    branch: task.branch,
    base: config.repo.baseBranch,
    remote: config.forge.remote,
    title: prTitle(issue),
    body: formatPrBody(issue, changes, {
      harness: config.harness.implement.kind,
      model: config.harness.implement.model ?? null,
      effort: config.harness.implement.effort ?? null,
    }),
    labels: amagiLabels(issue.type),
  })
  store.append(task.id, { type: 'pr.created', url: pr.url, number: pr.number })
  if (store.task(task.id)?.state === 'chatting') {
    store.append(task.id, { type: 'task.state', from: 'chatting', to: 'pr_open' })
  }
  return `opened PR #${pr.number}: ${pr.url}`
}
