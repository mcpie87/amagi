---
status: accepted
---

# Before and after checks are separate lists

Running every project check on the untouched worktree before agent work makes
a slow verification command, such as a full test suite, run twice per task.
Some repositories also want a cheap baseline probe before agent work and a
thorough gate after it, or no baseline at all.

Project checks are two ordered lists. `checks.before` runs on the untouched
worktree before agent work; a failure parks the task, as ADR 0006 decided for
the baseline. `checks.commands` runs after implementation and each fix and
keeps the commit gate and every other code-writing check path. Either list may
be empty. An absent `checks.before` runs the after checks, so existing
repositories keep their current baseline; `before = []` skips the baseline
explicitly. An absent `checks.commands` is still unfinished setup.

This supersedes the part of ADR 0006 that runs all configured commands before
agent work. ADR 0005's prohibition on guessed commands is unchanged.
