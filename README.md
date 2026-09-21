<p align="center">
  <img src="banner.png" alt="amagi" width="480">
</p>

# amagi

Orchestrates AI coding agents over an issue tracker. Amagi claims ready issues, works each one in its own git worktree, runs project checks, and loops back with fixes until the work passes, then hands it off as a pull request.

## How it works

- **Tracker** (`beads`, `github`, `forgejo`): issues come from an issue tracker. Amagi claims the next ready task and keeps the lease alive for the whole run.
- **Harness** (`claude`): the agent that implements and reviews. Runs in a dedicated worktree, so a repo stays clean while work is in flight.
- **Loop**: implement -> project checks -> commit -> pull request, with fix-up rounds when checks fail.
- **Server**: an HTTP + SSE event feed (`amagi serve`) so tools and humans can watch and steer runs, backed by a dashboard.

## Install

Requires [bun](https://bun.sh). Other tools (`git`, `beads`, `claude`, `gh`/`tea`) are resolved at runtime, only as needed by the trackers and harnesses you configure.

```bash
bun install
just check   # lint + typecheck + tests
```

For development, run `bun serve`. It starts the API with source watching and
the dashboard Vite server with hot module replacement. Open the dashboard at
the URL Vite prints (normally `http://localhost:5173`); `/api` requests proxy
to the API at `http://127.0.0.1:7777`.

### Dashboard

The dashboard is the shared control room for the connected server:

- **Overview** brings active runs, open pull requests, questions, and recent activity together.
- **Runs** searches and filters running, completed, and attention-needed work. Each run has live agent output with follow/pause, check results, a timeline, and workspace context.
- **Task board** browses tracker tasks with search, status filters, and a saved board/list preference.
- **Inbox** collects agent questions and stopped runs. Answer questions directly to resume waiting agents.
- **Activity** shows a searchable timeline of run milestones and decisions.

Use Ctrl+K or Cmd+K to find a page or run. Connection status shows when the event stream is reconnecting and displayed data may be stale. On small screens, navigation opens from the menu button.

Starting and stopping runs, editing tracker tasks, and registering multiple repositories still require backend support. The dashboard currently operates on the repository connected to its server.

## Usage

```bash
bun run packages/cli/src/index.ts <command>
```

| Command | Description |
| --- | --- |
| `run` | Claim the next ready task and work it in its own worktree. `--harness <name>` and `--model <name>` pin the harness and model; without them, a TTY run prompts for both (see [Harness and model selection](#harness-and-model-selection)) |
| `status` | Show the run queue and any open questions |
| `ask` | Ask the human a question and block for the answer |
| `check-prs` | List GitHub PRs and dispatch an agent to resolve any conflicts against the base branch |
| `respond-to-mentions` | Watch open PRs for @agent mentions; the LLM classifies each one and responds by fixing, explaining, logging a task, or asking for clarification |
| `clean` | Remove worktrees and branches for terminal tasks (dry run by default) |
| `config` | Print the resolved configuration and where it came from |
| `repos` | List registered repositories and their readiness diagnostics |
| `add <path>` | Register a repository with the orchestration workspace |
| `remove <key>` | Unregister a repository |
| `serve` | Serve the HTTP + SSE API and the built dashboard for every registered repo |
| `tui` | Terminal view of the queue, task detail, and pending questions (needs `amagi serve` running) |

### The repository registry

Amagi manages any number of repositories from one orchestration workspace. Repos are
registered in a registry (`~/.local/state/amagi/registry.json`) with `amagi add <path>` or
through the dashboard's onboarding form; each entry is scoped by a key (the repo directory
name unless you pass `--key`). `amagi repos` shows every registered repo and its readiness
(git root, config, tracker/forge CLIs on PATH, worktree root), and `amagi remove <key>`
drops one.

`amagi serve` hosts the dashboard and API for every registered repo. The dashboard's
workspace selector streams one repo at a time; tasks, tokens, logs, SSE subscriptions and
run actions are scoped per repo, so identical issue ids in different repos never collide.
Adding a repo while the server runs takes effect immediately, without a restart: the
server re-reads the registry on demand.

For the repo being served, its own `.amagi/config.toml` (merged with the global config)
picks the tracker, forge, harness and checks. The CLI (`run`, `status`, `clean`, `tui`,
`ask`) resolves the repo from your current working directory with
`git rev-parse --show-toplevel`, reads and writes that repo's own store, and addresses the
server's repo-scoped routes by that key.

The runner needs write access to create git worktrees next to the repo (`repo.worktreeRoot`, `~/.cache/amagi/worktrees` by default) and, for the `github` tracker/forge, a `GH_TOKEN` or `GITHUB_TOKEN` in the environment so `gh` and the unattended `git push`/`fetch` never block on interactive auth.

## The task state machine

Every task moves through a fixed set of states (`packages/core/src/events.ts`), recorded as `task.state` events in the store. Any state can fall to a terminal state (an unrecoverable error), so only forward progress is listed below:

| State | Meaning | Can advance to |
| --- | --- | --- |
| `claimed` | Task taken from the tracker; lease heartbeat started | `worktree_ready` |
| `worktree_ready` | Git worktree and branch created (and `repo.setupCmd` run, if set) | `implementing` |
| `implementing` | The implement harness is running | `awaiting_answer`, `checks` |
| `awaiting_answer` | The agent called `amagi ask` and is parked on a human answer | `implementing` |
| `checks` | Running `checks.commands` against the worktree | `implementing` (checks failed, retrying), `committed` (checks passed) |
| `committed` | Changes committed to the branch | `pr_open` |
| `pr_open` | Pull request opened against `repo.baseBranch` | `reviewing` |
| `reviewing` | Review harness runs against the PR | `fixing`, `done` |
| `fixing` | Implement harness addresses review findings | `awaiting_answer`, `checks`, `reviewing` |
| `done` | Terminal: task complete | — |
| `no_pr` | Terminal: the agent produced no changes, so the task looks already done or needs no PR. Surfaced to the user and **not closed until a human verifies and closes it explicitly** | — |
| `needs_human` | Terminal: stuck, needs manual attention (failed checks past the retry budget, lease lost, PR creation failed, agent crash, etc.) | — |
| `abandoned` | Terminal: task withdrawn | — |
| `cancelled` | Terminal: the operator stopped the run from the dashboard; the agent process was killed, the tracker lease released, and the worktree preserved for the reclaim path | — |

**Current status:** the runner (`packages/core/src/runner.ts`) drives `claimed` through `pr_open`, looping `implementing` <-> `checks` up to `loop.maxCheckRounds` times and parking on `awaiting_answer` whenever the agent asks a question. `reviewing`/`fixing`/`done` are modeled in the state machine and the dashboard already renders them, but the review loop itself (running `harness.review` and looping fixes for `loop.maxReviewRounds`) isn't wired into the runner yet. A task that reaches `pr_open` today stops there rather than continuing to `done`, unless the server is running: `amagi serve` polls open task PRs and settles a task to `done` when its PR merges or `abandoned` when it closes without a merge.

A task also carries a `reviewRound` counter (visible in `amagi status`) for when that loop lands.

## The runner service

`amagi serve` also hosts an operator-facing runner service. It reports
availability and capacity (`GET /api/runner`), launches a specific ready task
or the next ready one (`POST /api/runs`, with an optional `{ "taskId": ... }`
body), and stops a run it owns (`POST /api/runs/:id/stop`). Stop is graceful:
the owned agent process is killed, the tracker lease is released, and the task
is parked in the terminal `cancelled` state with its worktree untouched, so the
existing Reclaim action (or a fresh launch) resumes it where it left off. The
server runs up to `loop.maxParallel` tasks at once and refuses launch requests
that would exceed that or claim a task that is already running. The dashboard
surfaces all of this from the task board and task detail pages.

Capacity is enforced per server process: each `amagi serve` owns the runs it
launches. Launching the same task from a second server or from the CLI (`amagi
run`) relies on the tracker's atomic claim to avoid double-claiming.

## Configuration

Amagi is configured per-repo (`.amagi/config.toml`) and globally (`~/.config/amagi/config.toml`, or `$XDG_CONFIG_HOME/amagi/config.toml`); later sources win and are merged key by key (arrays are replaced wholesale, never concatenated). Run `amagi config` to print the fully resolved configuration and which files it came from, or `amagi config --json` for machine-readable output.

Every key is optional; the table below is the complete schema with its default.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `repo.baseBranch` | string | `"main"` | Branch new worktrees and PRs are based on. |
| `repo.worktreeRoot` | string | `~/.cache/amagi/worktrees` (`$XDG_CACHE_HOME/amagi/worktrees`) | Where per-task worktrees are created. `~` is expanded. |
| `repo.setupCmd` | string \| null | `null` | Shell command run once in a fresh worktree (e.g. `"bun install"`) before the agent starts. |
| `repo.persona` | string \| null | `null` | Git persona for commits/PRs: the name of a gitconfig fragment under `~/.config/git/personas/<name>.gitconfig` (e.g. `"agent-chise"`), included in each fresh worktree's own config so its `user.name`/`user.email` apply there without touching the main repo. |
| `tracker.kind` | `"beads"` \| `"github"` \| `"forgejo"` | `"beads"` | Issue source. `github`/`forgejo` use the `gh`/`tea` CLIs and label an issue `amagi-claimed` in place of a real lease. |
| `forge.kind` | `"github"` \| `"forgejo"` | `"github"` | Where pull requests are opened. Only `github` (via `gh`) is implemented today; `forgejo` throws `NotImplementedDriverError` if selected. |
| `forge.remote` | string | `"origin"` | Git remote pushed before opening the PR. |
| `forge.agentHandle` | string | `"chise-maru"` | Forge handle (without the `@`) the agent is pinged under on PRs; `respond-to-mentions` responds to mentions of it. |
| `harness.implement.kind` | `"claude"` \| `"codex"` \| `"opencode"` | `"claude"` | Harness that writes the code when no harness is picked at dispatch time. |
| `harness.implement.model` | string | *(harness default)* | Model name passed through to the harness, e.g. `"opus"`. |
| `harness.implement.effort` | string | *(harness default)* | Reasoning effort passed through (e.g. `low`/`medium`/`high`/`xhigh` for claude). |
| `harness.implement.permissions` | `"workspace-write"` \| `"bypass"` | `"workspace-write"` | Least blast radius that still lets an unattended agent work. `bypass` disables the harness's own permission system entirely — a worktree is isolation, not a sandbox. |
| `harness.implement.extraArgs` | string[] | `[]` | Extra argv appended to the harness invocation. |
| `harness.review.kind` | `"claude"` \| `"codex"` \| `"opencode"` | `"codex"` | Harness that reviews the PR. Reserved for the review loop (see [state machine](#the-task-state-machine)); not invoked by the runner yet. |
| `harness.review.model` | string | *(harness default)* | Same shape as `harness.implement.model`. |
| `harness.review.effort` | string | *(harness default)* | Same shape as `harness.implement.effort`. |
| `harness.review.permissions` | `"workspace-write"` \| `"bypass"` | `"workspace-write"` | Same shape as `harness.implement.permissions`. |
| `harness.review.extraArgs` | string[] | `[]` | Same shape as `harness.implement.extraArgs`. |
| `harness.definitions.<name>.<key>` | same as `harness.implement.*` | *(none)* | Named harness definitions offered by the `amagi run` interactive picker, e.g. `[harness.definitions.fast]` with `kind = "opencode"`. Each is a full harness config (`kind`, `bin`, `model`, `effort`, `permissions`, `extraArgs`). `--harness <name>` also accepts a definition name. When empty, the picker offers the three known kinds. |
| `loop.maxParallel` | integer >= 1 | `1` | Number of tasks worked concurrently. |
| `loop.maxReviewRounds` | integer >= 0 | `3` | Review/fix rounds before escalating to `needs_human`. Reserved for the review loop. |
| `loop.maxCheckRounds` | integer >= 0 | `2` | Extra implement attempts handed back when `checks.commands` fail, before escalating to `needs_human`. |
| `loop.questionTimeoutSec` | integer >= 10 | `540` | How long `amagi ask` itself blocks for an answer before returning control to the agent. Kept under the 600s Bash timeout harnesses impose on tool calls. |
| `loop.questionParkTimeoutSec` | integer >= 1 | `3600` | How long the runner waits, with the agent parked, for a human to answer via the dashboard or CLI before escalating to `needs_human`. |
| `checks.commands` | string[] | `[]` | Shell commands run in order against the worktree after the agent stops; the first non-zero exit stops the run and triggers a fix round. |
| `notify.desktop` | boolean | `true` | Send desktop notifications via `notify-send` (best effort; a missing binary is silently ignored). |
| `notify.ntfyTopic` | string \| null | `null` | [ntfy](https://ntfy.sh) topic to publish task events to. Unset disables ntfy notifications. |
| `notify.ntfyServer` | string | `"https://ntfy.sh"` | ntfy server base URL, for self-hosted instances. |
| `server.host` | string | `"127.0.0.1"` | Bind address for `amagi serve` and the address the CLI (`amagi ask`) talks to. |
| `server.port` | integer | `7777` | Port for `amagi serve`. |

`server.host`/`server.port` are read from the global config only: `serve` hosts every
registered repo, so there is no single repo config to draw them from.

### Example

```toml
# .amagi/config.toml
[repo]
baseBranch = "main"
setupCmd = "bun install"

[tracker]
kind = "beads"

[forge]
kind = "github"
remote = "origin"

[checks]
commands = ["just check"]
```

### Other environment variables

| Variable | Effect |
| --- | --- |
| `GH_TOKEN` / `GITHUB_TOKEN` | Used for the `github` tracker/forge: rewrites the remote to push/fetch over HTTPS with the token so an unattended run never prompts for an SSH passphrase. |
| `AMAGI_DB` | Overrides the SQLite store path (default `$XDG_STATE_HOME/amagi/amagi.db`). Mainly for tests and running multiple isolated instances. |
| `AMAGI_TASK_TOKEN` | Set by the runner in the harness's environment; `amagi ask` uses it to authenticate its request to the server. Not meant to be set by hand. |
| `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | Standard XDG overrides that relocate the global config, the SQLite store, and the default worktree root, respectively. |

For OpenCode with a local provider, select the provider/model name OpenCode already knows and, when NixOS wraps the default executable, set `bin` to the unconfined wrapper:

```toml
[harness.implement]
kind = "opencode"
bin = "opencode-unconfined"
model = "local/deepseek-ai/DeepSeek-V4-Flash-0731"
permissions = "bypass"
```

`permissions = "bypass"` passes `--auto` to OpenCode. The agent runs in Amagi's dedicated worktree, but OpenCode's own permission checks are otherwise disabled.

### Harness and model selection

`amagi run` can pick the harness and model at dispatch time, either from flags or an interactive picker. When neither `--harness` nor `--model` is given and stdin is a terminal, amagi prompts for a harness (the named `harness.definitions`, or `claude`/`codex`/`opencode` when none are defined) and then a model. Model lists are fetched the way each harness lists them (`claude model list`, `codex models`, `opencode models`) and cached under `$XDG_CACHE_HOME/amagi/models/` for 24h, so the prompt is fast and still offers the last known models offline. Non-interactive runs (no terminal) fall back to `harness.implement` with any `--model` override.

```bash
amagi run                      # interactive picker
amagi run --harness opencode   # pin the harness, pick the model
amagi run --harness fast --model local/deepseek-ai/DeepSeek-V4-Flash-0731
```

Define the choices the picker offers per repo:

```toml
[harness.definitions.fast]
kind = "opencode"
bin = "opencode-unconfined"
permissions = "bypass"

[harness.definitions.careful]
kind = "claude"
model = "opus"
```

## Packages

| Package | Purpose |
| --- | --- |
| `@amagi/core` | Runner, drivers, store, and event feed |
| `@amagi/cli` | The `amagi` command line |
| `@amagi/server` | HTTP + SSE event server |
| `@amagi/dashboard` | Web dashboard (React) |
| `@amagi/tui` | Terminal dashboard (Ink) |
