# Mention kind vocabulary is one table, and classification is routing only

A mention on a pull request is classified into every mention kind that applies before any handler runs. Two rules govern that step: the vocabulary shown to the classifier is generated from the same table the responder switches on, and the classifier itself is toolless, repo-less, and sees only pull request metadata.

The first rule exists because the alternative already failed in production. The prompt kept its own hardcoded list of labels while the type and the responder carried a fifth kind the classifier had never been told about. A human asked whether a pull request was superseded, the one kind that fit was invisible to the model, and the only honest answer left was `ambiguous`, so nothing happened. A mention kind that the vocabulary cannot name is unreachable, which makes the vocabulary a load-bearing interface and not a prompt detail. Adding a kind without a description is now a type error.

The second rule is a deliberate cost split. Classification runs on every mention; each handler runs only on the mentions that ask for it. Giving the classifier a worktree would slow every mention to pay for context that `add-a-task` never needs, and would let a routing decision wander into reading code. Pull request body, changed files and base/head shas are enough to tell a question from a fix request. The chosen handler is where full context is earned: `explain` gets the base-merged worktree, the pull request diff and the base commits landed since the branch point, which is what answering "is this still relevant" actually requires.

Classification was first a single label. A comment that asked a question and also requested a change got only one of the two: routed to `fix-pr` the question went unanswered, routed to `explain` the change was dropped. So the classifier now names every kind that applies, and the responder runs one handler per kind in table order. `explain` comes before `fix-pr`, so the answer describes the pull request the human was looking at, not the one the fix just pushed. `flag` and `ambiguous` stand alone: a pull request about to be judged for closure gets no fix, and a clarification request only makes sense when nothing else matched.

## Consequences

`explain` is deliberately wide: any question about the pull request routes there. `ambiguous` is a genuine last resort, not a shrug at anything unfamiliar, because stalling on a clarification round-trip is worse than answering the wrong question.

Classification is not free and not observable from its output alone, so it emits an event carrying the chosen kinds and the raw classifier reply. Without the raw reply a misroute is undiagnosable after the fact. Events stored when classification was a single label replay as a one-element list.

A multi-kind mention is retried as a whole when one handler fails, so each finished kind is recorded next to the handled mention ids and skipped on the retry: an explanation already posted is not posted twice.
