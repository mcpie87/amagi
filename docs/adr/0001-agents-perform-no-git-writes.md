# Agents perform no git writes

Amagi told agents contradictory things about git: the implement prompt forbade committing while the conflict and mention prompts ordered it, so whether an agent's work got committed depended on which phase it was in and how literally it read its instructions. We settled it in the restrictive direction: git is read-only to agents inside this repository, the runner performs every git write, and the rule is enforced by a shim ahead of git on the agent's PATH rather than by prompt text alone.

## Considered options

The obvious alternative, and the one proposed first, was the opposite: grant agents git authority scoped to their own worktree, with amagi explicitly overriding the operator's global no-git-write rules. Rejected for two reasons. The refusal that prompted the question turned out to quote amagi's own system prompt, not the operator's rules, so the authority grant would have fixed nothing that was actually broken. And a runner that sometimes commits and sometimes finds the agent already did is no longer deterministic, which is the property the whole orchestrator is built on.

Prompt-only enforcement was also rejected. "Do not commit" is exactly the class of instruction an agent overrides when it believes it knows better, which is how the inconsistency stayed invisible for as long as it did.

## Consequences

An agent that genuinely needs a git write has one escape hatch, `amagi git-request commit`, carried over the same channel as `amagi ask`. One verb, closed set, rejected on anything else.

The shim scopes by target repository rather than by verb alone. This is not fastidiousness: the project's own test suite runs `git init` and commits into temporary directories, and the implement prompt tells agents to run the project checks, so a verb-only shim would break the agent running `just check`.

Working-tree-mutating git (`checkout -- path`, `restore`, `clean`, `apply`) counts as a write too. Beyond keeping the rule to one sentence, this protects the runner: it decides the no-changes case from `git status --porcelain`, so an agent reverting its own work through git would silently turn a real task into "produced no changes".
