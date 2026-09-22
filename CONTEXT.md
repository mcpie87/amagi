# Amagi

An orchestrator that turns tracker issues into pull requests: it leases a task, runs a coding agent in an isolated worktree, commits the result on the agent's behalf, and opens the PR itself.

## Language

### Actors

**Runner**:
An ephemeral process that drives one task from claim to pull request, owning a single worktree for its lifetime.
_Avoid_: worker, task worker

**Watcher**:
A long-lived poller running under `amagi serve` that sweeps forge state on a fixed tick and dispatches work in reaction to it.
_Avoid_: worker, daemon, dedicated worker

**Agent**:
The harness LLM a runner or watcher spawns inside a worktree. It writes code and nothing else: it holds no forge credentials and never commits, pushes, labels, or comments.
_Avoid_: worker, model, harness

**Orchestrator**:
Amagi's own process, as distinct from the agents it spawns. Sole holder of forge credentials and sole author of every forge write.

### Pull request lifecycle

**Pointless pull request**:
An open pull request whose diff against its base is empty, so merging it would change nothing. Determined mechanically from the diff, never by model judgement.
_Avoid_: empty PR, dead PR, stale PR

**Stale pull request**:
An open pull request with no recent activity. Orthogonal to pointlessness: a stale PR may still carry a real diff.

**Flagging**:
Marking a pull request as a candidate for closure by labelling it and writing the reasoning where a human will read it. Amagi flags; only a human closes.
_Avoid_: taking down, auto-closing, killing

**Verdict**:
A runner's structured recommendation about its own pull request, emitted in its final summary for the orchestrator to validate and act on. A recommendation, never an action.

### Conflict checker

**Iteration**:
One conflict-resolution agent dispatch by the conflict checker against a single pull request. Counted per PR; a PR that keeps re-conflicting accumulates iterations and sinks in the dispatch order.
_Avoid_: attempt, pass
