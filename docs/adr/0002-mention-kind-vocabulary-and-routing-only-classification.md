# Mention kind vocabulary is one table, and classification is routing only

A mention on a pull request is classified into exactly one mention kind before any handler runs. Two rules govern that step: the vocabulary shown to the classifier is generated from the same table the responder switches on, and the classifier itself is toolless, repo-less, and sees only pull request metadata.

The first rule exists because the alternative already failed in production. The prompt kept its own hardcoded list of labels while the type and the responder carried a fifth kind the classifier had never been told about. A human asked whether a pull request was superseded, the one kind that fit was invisible to the model, and the only honest answer left was `ambiguous`, so nothing happened. A mention kind that the vocabulary cannot name is unreachable, which makes the vocabulary a load-bearing interface and not a prompt detail. Adding a kind without a description is now a type error.

The second rule is a deliberate cost split. Classification runs on every mention; the handlers run on one. Giving the classifier a worktree would slow every mention to pay for context that `add-a-task` never needs, and would let a routing decision wander into reading code. Pull request body, changed files and base/head shas are enough to tell a question from a fix request. The chosen handler is where full context is earned: `explain` gets the base-merged worktree, the pull request diff and the base commits landed since the branch point, which is what answering "is this still relevant" actually requires.

## Consequences

`explain` is deliberately wide: any question about the pull request routes there. `ambiguous` is a genuine last resort, not a shrug at anything unfamiliar, because stalling on a clarification round-trip is worse than answering the wrong question.

Classification is not free and not observable from its output alone, so it emits an event carrying the chosen kind and the raw classifier reply. Without the raw reply a misroute is undiagnosable after the fact.
