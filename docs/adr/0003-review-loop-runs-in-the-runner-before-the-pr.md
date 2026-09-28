# Review runs before the pull request, and unchecked work is never committed

The runner reviews the implementation in its worktree before creating a pull request. Review findings can trigger more implementation work, so the project checks run again after every review fix. Those checks use the same retry and recovery path as the checks after initial implementation.

If checks still fail after a review fix, the task stops in `needs_human`. The runner does not commit the work or open a pull request. This keeps the commit gate consistent even when review changes the worktree after the initial checks passed.
