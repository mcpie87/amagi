---
status: partially superseded by ADR-0007
---

# Repository setup owns user-defined project checks

Adding a repository currently registers an active participant before setup is
complete, and its configuration is scattered across settings tabs with
different repository selections. Required format, lint, and test categories
also prevent a repository from using a single existing verification command.

Use one repository setup flow and one repository settings page. Setup covers
the existing checkout, forge and credentials, tracker, project checks, and
activation. Register new repositories with workers and watchers paused; show
readiness problems beside the controls that resolve them, and require an
explicit activation step. Keep incomplete configurations editable without
constructing a runnable workspace. Existing repositories retain their
participation settings.

Project checks are an ordered list of operator-supplied shell commands, with
add, remove, edit, and reorder controls. No category is mandatory and no
command is invented or selected automatically. Preserve the existing timeout,
sandbox, cancellation, failure recovery, and check gates on code-writing
paths. Present all check controls together instead of splitting the command
list and timeout across settings tabs.

The repository page uses one repository selection and groups connection,
tracker, checks, automation, and advanced settings. Global fleet, execution
profiles, and credentials remain global, with links from setup where needed.
Show whether an effective value comes from a default, global configuration,
or a repository override. Preserve the existing storage boundaries behind the
page: repository configuration, local registration and identity, and shared
credentials.

Migration must preserve the current format, lint, test, and additional command
execution order. Existing configuration remains readable during migration;
the UI writes the unified list and removes the legacy category keys. An absent
list is unfinished setup; `commands = []` explicitly opts out. All configured
commands run on the untouched worktree before agent work, so a broken baseline
parks the task instead of becoming a tooling invention prompt. They run again
after implementation and fixes, preserving the existing commit gate.

This decision supersedes ADR 0004 and the fixed-category and format/lint-only
baseline policies in ADR 0005. ADR 0005's prohibition on guessed commands
remains: failed setup must not invite an agent to manufacture project tooling.
