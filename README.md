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

The dashboard is the shared control room for the connected server. A persistent sidebar navigates between the pages; the header shows the live connection status (streaming, reconnecting, or connecting), the runner status indicator (how many capacity slots are busy), and a **Search workspace** command palette (`Ctrl/Cmd+K`) that jumps to any page or task. On narrow screens the sidebar collapses behind a menu button, and the page content is inert while it is open. The repo selector and the button to register another repository live at the bottom of the sidebar. Six pages, plus a per-task detail:

- **Overview** opens with metric cards (active runs, workers busy, needs attention, open questions), a Workers panel (runner capacity, per-slot resource usage RSS/CPU/process count, running background workers like `respond-to-mentions` and `check-prs`), a Needs attention group for tasks stuck in attention states (each with its reason and close actions), and the live run list with a search box and a **Run next** button. An **Auto queue** toggle turns automatic dispatch on or off (when on, free slots are filled as tasks become claimable).
- **Tasks** browses the tracker's issues in board or list view (the choice is remembered), with a search box, a status filter, and create/edit modals. Clicking an issue opens its detail: description, acceptance criteria, and tracker fields, with an edit button.
- **Inbox** collects everything that needs a human: every open question (with one-tap options and a free-text answer) and the tasks needing attention.
- **Activity** is a feed of everything that happened across runs - claims, state changes, checks, commits, PRs, questions, retries, and errors - newest first, linked to the task.
- **Sessions** accounts for agent usage: total sessions, average duration, tokens used and cached, a breakdown by model and harness, and the recent sessions.
- **Settings** edits the server's max concurrent workers (`loop.maxParallel`).
- **Task detail** (linked from Overview, Tasks, Inbox, and Activity) shows the task's state and summary, its live agent log, token usage, worktree, branch, and PR, and any open questions, answerable in place, with Log/Checks tabs. Its actions cover reclaim, retry, stop, and instant close.

Starting and stopping runs, editing tracker tasks, and registering repositories are all live from the dashboard; the event stream is scoped to the selected repo.

## Usage

```bash
bun run packages/cli/src/index.ts <command>
```

| Command | Description |
| --- | --- |
| `run` | Claim the next ready task and work it in its own worktree. `--harness <name>`, `--model <name>` and `--effort <level>` pin the harness, model and reasoning effort; without them, a TTY run prompts for all three (see [Harness and model selection](#harness-and-model-selection)) |
| `triage` | Pick an unclaimed task the runner skips (epics, milestones, blocked, orphaned) and decide what to do with it: implement, decompose, close, ask the operator, or skip with a recorded reason. `--harness`, `--model` and `--effort` pin the decision harness (defaults to `harness.triage`) |
| `continue <task-id>` | Resume a task in its recorded worktree. `--harness`/`--model` restart it with a different harness or model |
| `stop <task-id>` | Interrupt a running task: park it in `cancelled` so its agent process is killed, then `continue` it (see [Interrupting and restarting a task](#interrupting-and-restarting-a-task)) |
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

The runner needs write access to create git worktrees next to the repo (`repo.worktreeRoot`, `~/.cache/amagi/worktrees` by default). Forge access is token-only: export the bot's token into the Amagi process environment (`GH_TOKEN`/`GITHUB_TOKEN` for `github`, `FORGEJO_TOKEN` for `forgejo`) and Amagi uses it for `gh`, `tea` and the unattended `git push`/`fetch` with no `gh auth login` or `tea login` step. Harness agents never inherit forge credentials: token env vars are stripped and their `gh`/`tea` are pointed at empty Amagi-owned config dirs, so an agent that reaches for the forge fails closed instead of using the operator's stored login.

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
| `pr_open` | Pull request opened against `repo.baseBranch` | `pr_flagged` |
| `pr_flagged` | The PR's diff against base is empty; flagged with `amagi/needs-closing` and parked for the operator to close. Non-terminal: the watcher clears it back to `pr_open` if real commits arrive | `pr_open` |
| `done` | Terminal: task complete | — |
| `no_pr` | Terminal: the agent produced no changes, so the task looks already done or needs no PR. The reason is the agent's own explanation (asked of it when it left none), so the operator knows why. Surfaced to the user and **not closed until a human verifies and closes it explicitly** | — |
| `needs_human` | Terminal: stuck, needs manual attention (failed checks past the retry budget, PR creation failed, agent crash, etc.) | — |
| `abandoned` | Terminal: task withdrawn, either by the operator's close action or by a PR closing without a merge | — |
| `cancelled` | Terminal: the operator interrupted the run (`amagi stop` or the dashboard's stop action); the agent process was killed, the tracker lease released, and the worktree preserved for the reclaim path (`amagi continue`) | — |

**Current status:** the runner (`packages/core/src/runner.ts`) drives `claimed` through `pr_open`, looping `implementing` <-> `checks` up to `loop.maxCheckRounds` times and parking on `awaiting_answer` whenever the agent asks a question. The review loop (a reviewer that inspects the PR and a fixing pass that addresses its findings) is not built yet; a task that reaches `pr_open` stops there rather than continuing to `done`, unless the server is running: `amagi serve` polls open task PRs and settles a task to `done` when its PR merges or `abandoned` when it closes without a merge.

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

`GET /api/runner` also carries per-task resource usage for the runner, summed
over each running task's whole agent process tree from `/proc` on Linux: resident
memory (`rssBytes`), CPU time (`cpuMs`), and process count (`processes`), keyed
by task id under `resources` plus the repo `name` the runner is bound to. The
dashboard's Workers section shows these numbers as a per-runner summary strip
and per busy slot, so the operator can see which runner is eating the machine.

Beyond stopping, the task detail page offers **instant close** (`POST
/api/repos/:repo/tasks/:id/close`): it retires any in-flight or parked task by
killing the worker if the runner owns it, deleting the task's worktree and
branch, closing the tracker ticket, and parking the task in the terminal
`abandoned` state. It is the operator's way to kill an in-flight task outright —
unlike stop, which preserves the worktree for the reclaim path.

Capacity is enforced per server process: each `amagi serve` owns the runs it
launches. Launching the same task from a second server or from the CLI (`amagi
run`) relies on the tracker's atomic claim to avoid double-claiming.

## The triage worker

The runner only claims the next ready task, so everything not directly
claimable is invisible to it: epics and milestones sit open, finished
containers stay open, blocked and orphaned tasks go untouched. The **triage
worker** (`packages/core/src/triage.ts`, `amagi triage`) is a separate decision
role that picks one unclaimed task a worker is not currently holding and asks a
harness to decide what to do with it:

- **implement**: the task is concrete ready work: claim it and hand it to the
  implementation runner (the triage role never writes code itself).
- **decompose**: the task is a container (epic/milestone) with no concrete
  children: break it into implementable subtasks under it.
- **close**: all children are done, or the work is already satisfied.
- **ask**: genuinely ambiguous: post a question on the task (surfaced in the
  dashboard inbox) and park it; once the operator answers, the next pass acts
  on that answer.
- **skip**: not for amagi to do: record the reason as a comment on the task.

Every decision is recorded as a `triage.decision` event in the store. Leaf
tasks are triaged once; a decomposed container is re-triaged only once all its
children have closed, so a finished epic gets closed instead of re-decomposed.
`amagi serve` also exposes `POST /api/repos/:repo/triage` to trigger a pass for
a repo through the dashboard.

A per-repo **stall watcher** (`loop.stallWatchIntervalSec`, default 5 minutes)
runs inside `amagi serve`. Every worker process records a liveness heartbeat
in the store while it drives a task; a worker that dies or hangs leaves its
task in an in-progress state with no fresh heartbeat. Once a task has been
silent for `loop.stallTimeoutSec` (default 1h) the watcher recovers it: it
releases the tracker claim (the issue reads ready again, and any surviving
runner of that task detects the lost lease and stops itself) and parks the
task back to `claimed` with its recorded worktree kept, so the next worker
resumes where the dead one left off. Only in-progress states are watched;
`pr_open` is excluded, since there the PR is out for human review and no
worker runs the task.

A per-repo **PR conflict watcher** (`loop.prCheckIntervalSec`, default 5
minutes) is the same idea as the mention watcher but for the `check-prs` flow:
each interval it lists open PRs, and any that conflict with `repo.baseBranch`
get a resolution agent dispatched on the same code path the `check-prs` CLI
uses. Ticks are sequential, and a PR is only attempted once per head SHA (the
attempted head is kept on disk), so an unresolvable conflict is not retried
until its head changes. Both watchers appear in the dashboard Workers section
with their own last-run stamp and counters.

The stall watcher's inactivity signal only sees a dead worker, not a stuck
one. A **doom-loop guard** (`loop.doomEnabled`, default on) runs on the same
tick and scans the agent event stream of every task with a live worker for
signs of busy-but-not-progressing work: repeated near-identical tool calls
(same command or file within `loop.doomToolWindowSec`, e.g. re-running the
same failing test forever), consecutive check rounds with the same failure
signature (`loop.doomCheckRounds`), or a worktree diff that has not changed
for `loop.doomDiffWindowSec` despite a live worker. When one trips, the guard
releases the tracker claim (stopping the run) and parks the task in the
terminal `needs_human` state with the reason, so a human looks instead of the
next worker re-burning budget on the same loop. Set `doomEnabled = false` to
turn it off.

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
| `forge.kind` | `"github"` \| `"forgejo"` | `"github"` | Where pull requests are opened. `github` goes through `gh`, `forgejo` through a direct token-authenticated Forgejo API client; both are token-only and never require an interactive login. |
| `forge.remote` | string | `"origin"` | Git remote pushed before opening the PR. |
| `forge.agentHandle` | string | `"chise-maru"` | Forge handle (without the `@`) the agent is pinged under on PRs; `respond-to-mentions` responds to mentions of it. |
| `harness.implement.kind` | `"claude"` \| `"codex"` \| `"opencode"` | `"claude"` | Harness that writes the code when no harness is picked at dispatch time. |
| `harness.implement.model` | string | *(harness default)* | Model name passed through to the harness, e.g. `"claude-opus-5"`. |
| `harness.implement.effort` | string | *(harness default)* | Reasoning effort passed through (e.g. `low`/`medium`/`high`/`xhigh` for claude). |
| `harness.implement.permissions` | `"workspace-write"` \| `"bypass"` | `"workspace-write"` | Least blast radius that still lets an unattended agent work. `bypass` disables the harness's own permission system entirely — a worktree is isolation, not a sandbox. |
| `harness.implement.extraArgs` | string[] | `[]` | Extra argv appended to the harness invocation. |
| `harness.review.kind` | `"claude"` \| `"codex"` \| `"opencode"` | `"codex"` | Harness that reviews the PR. Reserved for the review loop (see [state machine](#the-task-state-machine)); not invoked by the runner yet. |
| `harness.review.model` | string | *(harness default)* | Same shape as `harness.implement.model`. |
| `harness.review.effort` | string | *(harness default)* | Same shape as `harness.implement.effort`. |
| `harness.review.permissions` | `"workspace-write"` \| `"bypass"` | `"workspace-write"` | Same shape as `harness.implement.permissions`. |
| `harness.review.extraArgs` | string[] | `[]` | Same shape as `harness.implement.extraArgs`. |
| `harness.triage.kind` | `"claude"` \| `"codex"` \| `"opencode"` | `"claude"` | Harness that decides what to do with unclaimed tasks the runner skips. It reads task context and reports a structured decision; it never touches the repository. |
| `harness.triage.model` | string | *(harness default)* | Same shape as `harness.implement.model`. |
| `harness.triage.effort` | string | *(harness default)* | Same shape as `harness.implement.effort`. |
| `harness.triage.permissions` | `"workspace-write"` \| `"bypass"` | `"workspace-write"` | Same shape as `harness.implement.permissions`. |
| `harness.triage.extraArgs` | string[] | `[]` | Same shape as `harness.implement.extraArgs`. |
| `harness.definitions.<name>.<key>` | same as `harness.implement.*` | *(none)* | Named harness definitions offered by the `amagi run` interactive picker, e.g. `[harness.definitions.fast]` with `kind = "opencode"`. Each is a full harness config (`kind`, `bin`, `model`, `effort`, `permissions`, `extraArgs`). `--harness <name>` also accepts a definition name. When empty, the picker offers the three known kinds. |
| `loop.maxParallel` | integer >= 1 | `1` | Number of tasks worked concurrently. |
| `loop.maxCheckRounds` | integer >= 0 | `2` | Extra implement attempts handed back when `checks.commands` fail, before escalating to `needs_human`. |
| `loop.prCheckIntervalSec` | integer >= 1 | `300` | How often the PR conflict watcher scans open PRs and dispatches a resolution agent per one conflicting with `repo.baseBranch`. Each PR is only attempted once per head SHA, so the default 5 minutes stays inside GitHub REST rate limits. |
| `loop.stallWatchIntervalSec` | integer >= 1 | `300` | How often the stall watcher scans in-progress tasks for a worker that stopped heartbeating. Only reads the local store, so the default 5 minutes is cheap. |
| `loop.stallTimeoutSec` | integer >= 60 | `3600` | How long a task may sit in an in-progress state with no worker heartbeat before the stall watcher reclaims it: it releases the tracker claim so the issue is ready again and parks the task back to `claimed`, keeping the worktree for the next worker to resume. |
| `loop.doomEnabled` | boolean | `true` | Doom-loop guard: the stall watcher also scans tasks with a live worker for busy-but-not-progressing agents and stops the run. Set false to disable. |
| `loop.doomToolWindowSec` | integer >= 1 | `600` | Repeated near-identical tool calls (same command or file) within this many seconds trip the guard. |
| `loop.doomToolRepeat` | integer >= 2 | `20` | How many near-identical tool calls within the window trip the guard. |
| `loop.doomCheckRounds` | integer >= 2 | `3` | Consecutive check rounds sharing one failure signature that trip the guard. |
| `loop.doomDiffWindowSec` | integer >= 60 | `1800` | A live worker whose worktree diff has not changed for this many seconds trips the guard. |
| `loop.questionTimeoutSec` | integer >= 10 | `540` | How long `amagi ask` itself blocks for an answer before returning control to the agent. Kept under the 600s Bash timeout harnesses impose on tool calls. |
| `loop.questionParkTimeoutSec` | integer >= 1 | `3600` | How long the runner waits, with the agent parked, for a human to answer via the dashboard or CLI before escalating to `needs_human`. |
| `loop.contextWarnTokens` | integer >= 0 | `160000` | Input context (input + cached tokens) at which a run is flagged: the runner appends a `context.warn` event once the run's peak context reaches it. Kept under `loop.contextMaxTokens`. |
| `loop.contextMaxTokens` | integer >= 0 | `200000` | Input context at which a run is stopped: crossing it kills the current agent process and routes the task to `needs_human` instead of letting the harness degrade. |
| `loop.contextOverrides.<harness>.warnTokens` | integer >= 0 | *(falls back to `loop.contextWarnTokens`)* | Per-harness soft limit, keyed by harness kind (`claude`/`codex`/`opencode`), for harnesses whose context window differs. |
| `loop.contextOverrides.<harness>.maxTokens` | integer >= 0 | *(falls back to `loop.contextMaxTokens`)* | Per-harness hard limit, keyed by harness kind, for harnesses whose context window differs. |
| `loop.autoQueue` | boolean | `false` | Automatic dispatch: while on, the runner polls for the next ready task and launches it whenever a slot is free. Toggleable from the dashboard Workers section; off means dispatch is manual (Run next). |
| `loop.autoQueueIdleSec` | integer >= 1 | `60` | How long the auto-queue waits between polls when nothing is claimable, so an empty queue does not hammer the tracker. |
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
| `GH_TOKEN` / `GITHUB_TOKEN` | The bot's GitHub token, exported into the Amagi process environment. Used for the `github` tracker/forge: `gh` runs against an Amagi-owned `GH_CONFIG_DIR` with this token (no `gh auth` state) and the remote is rewritten to push/fetch over HTTPS so an unattended run never prompts for an SSH passphrase. |
| `FORGEJO_TOKEN` | The bot's Forgejo token for the `forgejo` tracker/forge. Amagi provisions a dedicated tea login from it into its own XDG config profile (no `tea login` step) and uses it for the direct Forgejo PR API client. `GITEA_SERVER_URL` (or the repo's origin remote) supplies the server URL. |
| `AMAGI_DB` | Overrides the SQLite store path (default `$XDG_STATE_HOME/amagi/amagi.db`). Mainly for tests and running multiple isolated instances. |
| `AMAGI_TASK_TOKEN` | Set by the runner in the harness's environment; `amagi ask` uses it to authenticate its request to the server. Not meant to be set by hand. |
| `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | Standard XDG overrides that relocate the global config, the SQLite store, and the default worktree root, respectively. |

Forge credentials never reach harness agents: token env vars are stripped from the agent's environment and `gh`/`tea` are pointed at empty Amagi-owned config dirs (`$XDG_STATE_HOME/amagi/forge/agents/`), so an agent that tries the forge fails closed instead of inheriting the operator's or the bot's stored login.

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

`amagi run` can pick the harness, model and reasoning effort at dispatch time, either from flags or an interactive picker. When neither `--harness`, `--model` nor `--effort` is given and stdin is a terminal, amagi prompts for a harness (the named `harness.definitions`, or `claude`/`codex`/`opencode` when none are defined), then a model, then an effort. Model and effort options for claude and codex are curated in `packages/core/src/models.json`, loaded once at startup, so a new model ships as a data change rather than a CLI scrape. `opencode` keeps listing its own models, cached under `$XDG_CACHE_HOME/amagi/models/` for 24h. Non-interactive runs (no terminal) fall back to `harness.implement` with any `--model`/`--effort` override.

```bash
amagi run                      # interactive picker
amagi run --harness opencode   # pin the harness, pick the model and effort
amagi run --harness codex --model gpt-5.6-sol --effort high
```

Define the choices the picker offers per repo:

```toml
[harness.definitions.fast]
kind = "opencode"
bin = "opencode-unconfined"
permissions = "bypass"

[harness.definitions.careful]
kind = "claude"
model = "claude-opus-5"
```

### Interrupting and restarting a task

A task that hangs (the harness process stops producing output, the machine
froze, the runner died) is not stranded: interrupt it, then start it again in
the same worktree, optionally with a different harness or model.

```bash
amagi stop bd-1234        # park the run in `cancelled`; a live runner kills its agent process
amagi continue bd-1234    # resume in the recorded worktree with the configured harness
amagi continue bd-1234 --harness opencode --model local/...   # same worktree, different harness/model
```

`amagi continue` re-claims the task and drives it in the worktree and branch
already recorded for it, so no work is lost. The same stop/restart flow is
available over the API (`POST /api/tasks/:id/stop` and
`POST /api/tasks/:id/reclaim`) for the dashboard.

## Packages

| Package | Purpose |
| --- | --- |
| `@amagi/core` | Runner, drivers, store, and event feed |
| `@amagi/cli` | The `amagi` command line |
| `@amagi/server` | HTTP + SSE event server |
| `@amagi/dashboard` | Web dashboard (React) |
| `@amagi/tui` | Terminal dashboard (Ink) |
