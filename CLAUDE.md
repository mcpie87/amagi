# Project Instructions for AI Agents

Amagi turns tracker issues into pull requests: it leases a task, runs a coding agent in an isolated git worktree, commits on the agent's behalf and opens the PR itself. Domain vocabulary (runner, worker, watcher, seat, verdict, mention kind) is defined in `CONTEXT.md`; use those terms.

When you are an agent spawned by amagi inside a worktree, the orchestrator prompt wins over everything below: no git writes, no claiming or closing beads, no session-completion protocol.

## Commands

Bun workspace, TypeScript, biome. Never pipe check output through `head`/`tail` (SIGABRT on BrokenPipe); redirect to a file and grep it.

```bash
just fmt                               # biome check --write .
just lint                              # biome check .
just typecheck                         # tsc --noEmit
bun test packages/core/src/foo.test.ts # one test file: prefer this while iterating
just check                             # lint + typecheck + dashboard build + all tests (slow, run once at the end)
```

`serve.test.ts` needs `packages/dashboard/dist`: run `just build-dashboard` first if it fails on missing files. `just fresh-check` wipes `node_modules`; it is a merge gate, do not run it while iterating.

## Layout

- `packages/core/src`: everything that does work.
  - `runner.ts` task lifecycle (claim, worktree, verify, implement, checks, commit, PR); `run-service.ts` the worker loop around it.
  - `prompt.ts` every agent prompt; `pr-body.ts` PR body; `events.ts` the event union; `store/` SQLite event store; `project.ts` the event reducer, shared with the UIs through `view.ts`.
  - `drivers/harness/{claude,codex,opencode}.ts` harness argv and stream translators, `spawn.ts` shared process wiring, `env.ts` agent env, `shim.ts` read-only git/amagi shims.
  - `drivers/tracker/{beads,forge}.ts` trackers, `drivers/pr.ts` GitHub/Forgejo PR driver.
  - `mentions.ts`, `conflict.ts`, `pointless.ts`, `pr-check.ts`, `triage.ts`, `difficulty.ts`: watcher and classifier logic.
  - `config.ts` config schema (repo `.amagi/config.toml` layered over the user config).
- `packages/server/src`: Hono API + SSE (`app.ts`), `serve.ts`, and the pollers/watchers (`*-poller.ts`, `*-watcher.ts`).
- `packages/cli/src`: the `amagi` CLI, one file per command in `commands/`.
- `packages/dashboard/src`: React 19 + TanStack Router web UI. `routes.tsx` is only the route tree; each page lives in `views/*.tsx`, shared pieces in `layout.tsx`, `badges.tsx`, `format.ts`, `markdown.tsx`; `store.tsx` holds client state.
- `packages/tui/src`: Ink terminal UI.

Tests sit next to the code as `*.test.ts`. `runner.test.ts` and `server/src/app.test.ts` are large: grep for the `describe`/`test` you need and read that range, not the whole file.

## Conventions

- Match the surrounding code; reuse helpers in `core/src` (`exec.ts`, `errors.ts`, `format.ts`, `paths.ts`) before writing new ones.
- Comments only for non-obvious constraints, never to narrate a change.
- Every new event type goes into `events.ts`; fold it in `project.ts` when the UIs need it.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
