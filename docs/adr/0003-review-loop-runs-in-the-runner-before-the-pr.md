# Review runs before the pull request, and unchecked work is never committed

The runner reviews the implementation in its worktree before creating a pull request. Review findings can trigger more implementation work, so the project checks run again after every review fix. Those checks use the same retry and recovery path as the checks after initial implementation.

If checks still fail after a review fix, the task stops in `needs_human`. The runner does not commit the work or open a pull request. This keeps the commit gate consistent even when review changes the worktree after the initial checks passed.

The same holds when review itself ends without an acceptable verdict: exhausted rounds, tokens or cost, blocking findings that make no progress, a reviewer that fails, or implementer replies the runner cannot read. The task stops in `needs_human` with the worktree kept, nothing is committed or pushed, and no pull request is opened. An earlier design opened the pull request anyway with the unresolved findings and an `amagi/review-unresolved` label; that put work with open blocking findings up for merge as if it were ready, so it was dropped.
