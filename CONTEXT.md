# Amagi

An orchestrator that turns tracker issues into pull requests: it leases a task, runs a coding agent in an isolated worktree, commits the result on the agent's behalf, and opens the PR itself.

## Language

### Work

**Task**:
A unit of work amagi can lease, seen whole: its issue together with everything amagi has done to it, from runs and review rounds to its pull request. The one object the operator steers, across every repository.
_Avoid_: job, ticket, bead

**Issue**:
The tracker-side record of a task: title, description, priority, dependencies and tracker status. Owned by the tracker; amagi reads and edits it but never treats it as the whole task.
_Avoid_: task (when only the tracker record is meant)

**Stage**:
Where a task sits on its path from backlog to merged pull request, derived from its tracker status and run state together. The single grouping the operator sees tasks in.
_Avoid_: column, status, state

**Epic**:
An issue that groups tasks and is never leased itself, so it is not a task. It is finished once every child is closed, and its progress is the share of children closed.
_Avoid_: parent task, milestone, project

**Proposal**:
A follow-up an agent filed as out of scope for its own task, held out of the ready queue until a human accepts or dismisses it. A human decision, so it waits in the inbox, not among tasks.
_Avoid_: suggestion, follow-up issue

### Actors

**Execution profile**:
A named combination of harness, model and reasoning effort, shortened to profile. A profile describes how an agent runs, independently of its credential seat.
_Avoid_: worker, seat, harness definition

**Worker**:
A named, configured lane in the fleet, carrying one harness, model, effort and seat. A worker is a definition that outlives the runners it spawns, and it has at most one agent alive at a time.
_Avoid_: slot, runner, thread

**Runner**:
An ephemeral process that drives one task from claim to pull request, owning a single worktree for its lifetime. A worker spawns runners; it is not one.
_Avoid_: worker, task worker

**Watcher**:
A long-lived poller that sweeps forge state on a fixed tick and dispatches work in reaction to it. Configured once, globally, and instantiated per participating repository.
_Avoid_: worker, daemon, dedicated worker

**Seat**:
The credential an agent authenticates as, such as a single Claude subscription. At most one worker or watcher agent is ever live on a seat. Two workers may name the same seat, and then they take turns. Chat replies ignore seats; like every agent they wait only on the host-wide harness process cap.
_Avoid_: account, subscription, credential, lane

**Fleet**:
Every worker and watcher defined on one machine. Global rather than per repository, because a seat belongs to a person while one server hosts many repositories.
_Avoid_: pool, roster, worker list

**Agent**:
The harness LLM a runner or watcher spawns inside a worktree. It writes code and nothing else: git is read-only to it, it holds no forge credentials, and it never commits, pushes, labels, or comments.
_Avoid_: worker, model, harness

**Git request**:
An agent's only way to cause a git write: a single closed verb sent over the task channel, which the runner either performs or rejects. Never prose the runner interprets.
_Avoid_: git command, agent commit

**Orchestrator**:
Amagi's own process, as distinct from the agents it spawns. Sole holder of forge credentials and sole author of every forge write.

**Review round**:
A reviewer pass, followed by a fix pass only when blocking findings remain and work is allowed to continue. A round can also end with blocking findings unresolved when work stops before a fix pass.

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
A structured recommendation about a pull request, emitted by whichever agent was asked to judge it: a runner assessing its own work, or a mention-driven agent judging an existing pull request. A recommendation, never an action.

**Superseded pull request**:
An open pull request whose intent has already been achieved on the base branch, so its diff still applies but no longer buys anything. Unlike a pointless pull request this needs judgement, not a diff check, and it is orthogonal to staleness.
_Avoid_: obsolete PR, redundant PR

### Conflict checker

**Iteration**:
One conflict-resolution agent dispatch by the conflict checker against a single pull request. Counted per PR; a PR that keeps re-conflicting accumulates iterations and sinks in the dispatch order.
_Avoid_: attempt, pass

### Mentions

**Mention**:
A comment on a pull request naming the agent handle, written by anyone but the agent itself. The unit of work the mention watcher sweeps for.

**Mention kind**:
One response path a mention is routed to, drawn from a closed vocabulary that is the same list the classifier is shown and the same list the responder can act on. A mention gets every kind that applies, each handled in vocabulary order; `flag` and `ambiguous` always stand alone. A mention the vocabulary cannot name is not routed at all, so the vocabulary is the limit of what a human can ask for on a pull request.
_Avoid_: intent, category, mention type

### Project checks

**Project check**:
A repository-specific command chosen by the operator to prepare or verify agent changes. Project checks form ordered lists whose contents belong to the repository; Amagi does not prescribe format, lint, or test categories.

**Before check**:
A project check run on the untouched worktree before agent work. A failure means the baseline or the tooling is broken, so the task parks instead of reaching an agent. Defaults to the after checks when not declared.

**After check**:
A project check run after agent work and each fix. A failure starts a fix round; passing gates the commit.
_Avoid_: mandatory formatter, mandatory lint, mandatory test

**Services**:
The containers a worktree's setup and project checks depend on (database, queue), started by amagi per worktree from a repository-declared command and reachable only from that worktree's private network. They live until the worktree is removed.
_Avoid_: infra, stack
